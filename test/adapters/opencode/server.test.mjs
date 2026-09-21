import { isolateCompassEnvironment } from "../../helpers/compass-environment.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import OpenCodeShadow from "../../../adapters/opencode/server.js";
import { translateOpenCodeEvent, buildGroundingEvent } from "../../../adapters/opencode/translate.mjs";
import { createGroundingCache } from "../../../adapters/opencode/grounding.mjs";
import { createResponse, encodeFrame, FrameDecoder } from "../../../src/protocol/rpc.mjs";
import { openLedger } from "../../../src/state/ledger.mjs";
import { startSupervisor } from "../../../src/supervisor/server.mjs";

const authKey = Buffer.alloc(32, 0x62);
const restoreAliases = isolateCompassEnvironment();
test.after(restoreAliases);
const originalStateDir = process.env.COMPASS_STATE_DIR;
const originalCoalescingConfig = process.env.COMPASS_COALESCING_CONFIG;
const hermeticStateDir = mkdtempSync(join(tmpdir(), "ah-opencode-state-"));
process.env.COMPASS_STATE_DIR = hermeticStateDir;
delete process.env.COMPASS_COALESCING_CONFIG;
let environmentRestored = false;
function restoreEnvironment() {
  if (environmentRestored) return;
  environmentRestored = true;
  if (originalStateDir === undefined) delete process.env.COMPASS_STATE_DIR;
  else process.env.COMPASS_STATE_DIR = originalStateDir;
  if (originalCoalescingConfig === undefined) delete process.env.COMPASS_COALESCING_CONFIG;
  else process.env.COMPASS_COALESCING_CONFIG = originalCoalescingConfig;
  rmSync(hermeticStateDir, { recursive: true, force: true });
}
process.once("exit", restoreEnvironment);
test.after(restoreEnvironment);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ah-opencode-"));
  const keyFile = join(root, "auth.key");
  const socketPath = join(root, "private", "supervisor.sock");
  const ledger = openLedger({ path: join(root, "ledger", "events.sqlite"), hmacKey: authKey });
  await writeFile(keyFile, authKey, { mode: 0o600 });
  const supervisor = await startSupervisor({ socketPath, authKey, ledger });
  t.after(async () => { await supervisor.close(); ledger.close(); });
  return { keyFile, socketPath, ledger };
}

async function withEnv(values, operation) {
  const old = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try { return await operation(); } finally {
    for (const [key, value] of Object.entries(old)) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
}

async function writeCoalescingConfig(overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "ah-opencode-config-"));
  const path = join(root, "coalescing.json");
  await writeFile(path, JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    windowMs: 10_000,
    queueMax: 256,
    preserveLabels: ["lifecycle", "tool", "permission", "error"],
    dlpOverride: true,
    ...overrides,
  }));
  return path;
}

async function fakeSupervisor(t, { stalled = false, appendFailures = 0, abortAppend = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "ah-opencode-fake-"));
  const socketPath = join(root, "supervisor.sock");
  const sockets = new Set();
  const requests = [];
  const ackedAppends = [];
  let connections = 0;
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  const server = net.createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    // The client under test legitimately closes or aborts mid-write in the abort,
    // timeout, and dispose scenarios; swallow the resulting EPIPE/ECONNRESET so the
    // fake server never raises an unhandled socket error and flakes the run.
    socket.on("error", () => {});
    const decoder = new FrameDecoder();
    socket.on("data", async (chunk) => {
      for (const request of decoder.push(chunk)) {
        requests.push(request);
        if (stalled) await released;
        if (request.method === "append" && appendFailures > 0) {
          appendFailures -= 1;
          if (abortAppend) {
            socket.destroy();
            continue;
          }
          if (!socket.destroyed) socket.end(encodeFrame(createResponse({
            id: request.id,
            error: { code: "FAILED", message: "synthetic append failure" },
          })));
          continue;
        }
        if (request.method === "append") ackedAppends.push(request.params.event);
        if (!socket.destroyed) socket.end(encodeFrame(createResponse({ id: request.id, result: {} })));
      }
    });
  });
  await new Promise((resolve, reject) => server.listen(socketPath, resolve).once("error", reject));
  t.after(async () => {
    release();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return { socketPath, requests, ackedAppends, release, get connections() { return connections; } };
}

async function waitFor(predicate, timeout = 1_000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail("condition was not met before timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function fakeClock() {
  let current = Date.parse("2026-09-09T12:00:00.000Z");
  return {
    now: () => current,
    advance(milliseconds) { current += milliseconds; },
  };
}

function fakeTimers(clock) {
  let nextID = 0;
  const timers = new Map();

  function setTimeoutFake(callback, delay) {
    const handle = { id: ++nextID, unref() {} };
    timers.set(handle, { callback, due: clock.now() + delay });
    return handle;
  }

  function clearTimeoutFake(handle) {
    timers.delete(handle);
  }

  async function advance(milliseconds) {
    clock.advance(milliseconds);
    const due = [...timers].filter(([, timer]) => timer.due <= clock.now());
    const pending = [];
    for (const [handle, timer] of due) {
      timers.delete(handle);
      const result = timer.callback();
      if (result && typeof result.then === "function") pending.push(result);
    }
    await Promise.all(pending);
    await Promise.resolve();
    await Promise.resolve();
  }

  return { setTimeout: setTimeoutFake, clearTimeout: clearTimeoutFake, advance };
}

function captureGlobalTimer(delay) {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const captured = [];
  globalThis.setTimeout = (callback, timeout, ...args) => {
    if (timeout === delay) {
      const handle = { callback: () => callback(...args), unref() {} };
      captured.push({ handle, cleared: false });
      return handle;
    }
    return realSetTimeout(callback, timeout, ...args);
  };
  globalThis.clearTimeout = (handle) => {
    const timer = captured.find(({ handle: candidate }) => candidate === handle);
    if (timer) {
      timer.cleared = true;
      return;
    }
    return realClearTimeout(handle);
  };
  return {
    captured,
    restore() {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    },
  };
}

test("event and tool hooks append serially, deduplicate replay, and persist no raw content", async (t) => {
  const { keyFile, socketPath, ledger } = await fixture(t);
  await withEnv({ COMPASS_KEY_FILE: keyFile, COMPASS_SOCKET: socketPath }, async () => {
    const hooks = await OpenCodeShadow({ directory: "/raw/directory", worktree: "/raw/worktree" });
    await hooks.event({ event: {
      id: "native-event", type: "session.created",
      properties: { info: { id: "native-session", projectID: "project", directory: "/raw/directory", title: "RAW-MESSAGE", version: "1.18.20", time: { created: 1, updated: 1 } } },
    } });
    const toolInput = { sessionID: "native-session", tool: "bash", callID: "native-call" };
    await hooks["tool.execute.before"](toolInput, { args: { command: "RAW-ARGS" } });
    await hooks["tool.execute.after"](toolInput, { result: "RAW-RESULT" });
    await hooks["tool.execute.after"](toolInput, { result: "RAW-RESULT" });
    await hooks.dispose();

    const runID = translateOpenCodeEvent({ type: "session.created", sessionID: "native-session" }, { authKey }).runID;
    const events = ledger.listEvents(runID);
    assert.deepEqual(events.map(({ eventType }) => eventType), ["SessionStart", "PreToolUse", "PostToolUse"]);
    const serialized = JSON.stringify(events);
    for (const sentinel of ["RAW-MESSAGE", "RAW-ARGS", "RAW-RESULT", "/raw/", "native-call", "native-session"]) {
      assert.equal(serialized.includes(sentinel), false, `persisted ${sentinel}`);
    }
  });
});

test("event payloads and real two-argument tool hooks persist observe decisions without secrets", async (t) => {
  const { keyFile, socketPath, ledger } = await fixture(t);
  const eventSentinel = "Authorization: Bearer b7Qx_2mN9-vR4.kL8sP0";
  const beforeSentinel = "token: 'tK9_mP4-vQ7.zR2'";
  const afterSentinel = "grafana: glsa_QWxwaGFCZXRhR2FtbWFEZWx0YQ";
  await withEnv({ COMPASS_KEY_FILE: keyFile, COMPASS_SOCKET: socketPath }, async () => {
    const hooks = await OpenCodeShadow({});
    await hooks.event({ event: {
      id: "native-event",
      type: "message.updated",
      properties: { info: { id: "message", sessionID: "native-session", text: eventSentinel } },
    } });
    const tool = { sessionID: "native-session", tool: "bash", callID: "native-call" };
    await hooks["tool.execute.before"](tool, { args: { command: beforeSentinel } });
    await hooks["tool.execute.after"](tool, { result: afterSentinel });
    await hooks.dispose();

    const runID = translateOpenCodeEvent({ type: "session.created", sessionID: "native-session" }, { authKey }).runID;
    const events = ledger.listEvents(runID);
    assert.deepEqual(events.map(({ decision }) => decision), [
      {
        schemaVersion: 1,
        action: "observe",
        ruleIDs: ["dlp.bearer-token"],
        reason: "Credential-shaped content was observed",
      },
      {
        schemaVersion: 1,
        action: "observe",
        ruleIDs: ["dlp.credential-assignment"],
        reason: "Credential-shaped content was observed",
      },
      {
        schemaVersion: 1,
        action: "observe",
        ruleIDs: ["dlp.grafana-token"],
        reason: "Credential-shaped content was observed",
      },
    ]);
    const serialized = JSON.stringify(events);
    for (const sentinel of [eventSentinel, beforeSentinel, afterSentinel]) {
      assert.equal(serialized.includes(sentinel), false, `persisted ${sentinel}`);
    }
  });
});

test("host hooks return immediately and unavailable supervisor fails open", async () => {
  await withEnv({ COMPASS_KEY_FILE: "/missing/key", COMPASS_SOCKET: "/missing/socket" }, async () => {
    const hooks = await OpenCodeShadow({});
    assert.equal(await hooks.event({ event: { type: "session.created", sessionID: "secret" } }), undefined);
    assert.equal(await hooks["tool.execute.before"]({ sessionID: "secret", tool: "bash" }, { args: "secret" }), undefined);
    await hooks.dispose();
  });
});

test("dispose drains queued events before returning", async (t) => {
  const { keyFile, socketPath, ledger } = await fixture(t);
  await withEnv({ COMPASS_KEY_FILE: keyFile, COMPASS_SOCKET: socketPath }, async () => {
    const hooks = await OpenCodeShadow({});
    for (let index = 0; index < 8; index += 1) {
      await hooks.event({ event: { type: "session.updated", sessionID: "session", id: `event-${index}` } });
    }
    await hooks.dispose();
    const runID = translateOpenCodeEvent({ type: "session.updated", sessionID: "session" }, { authKey }).runID;
    assert.equal(ledger.listEvents(runID).length, 8);
  });
});

test("queue is bounded while the supervisor is stalled and retains only translated closed events", async (t) => {
  const supervisor = await fakeSupervisor(t, { stalled: true });
  const root = await mkdtemp(join(tmpdir(), "ah-opencode-key-"));
  const keyFile = join(root, "auth.key");
  await writeFile(keyFile, authKey, { mode: 0o600 });

  await withEnv({ COMPASS_KEY_FILE: keyFile, COMPASS_SOCKET: supervisor.socketPath }, async () => {
    const hooks = await OpenCodeShadow({});
    for (let index = 0; index < 1_024; index += 1) {
      const event = { type: "session.updated", sessionID: `session-${index}`, id: `event-${index}`, raw: `RAW-${index}` };
      hooks.event({ event });
      event.sessionID = `MUTATED-${index}`;
      event.raw = `MUTATED-RAW-${index}`;
    }
    await waitFor(() => supervisor.requests.length === 1);
    supervisor.release();
    await hooks.dispose();

    const appended = supervisor.requests.filter(({ method }) => method === "append").map(({ params }) => params.event);
    assert.ok(appended.length > 0);
    assert.ok(appended.length <= 256, `retained ${appended.length} events`);
    for (const event of appended) {
      const expectedFields = [
        "adapterVersion", "dedupeKey", "eventID", "eventType", "platform", "runID", "schemaVersion", "sessionHMAC", "timestamp",
      ];
      if (event.eventType === "HarnessMetrics") {
        expectedFields.push("summary");
        assert.deepEqual(Object.keys(event.summary).sort(), [
          "coalesced", "messagePartDelta", "messagePartUpdate", "messageUpdate",
          "noise", "queueFull", "sessionDiff", "sessionStatus", "todoUpdate",
        ]);
      }
      assert.deepEqual(Object.keys(event).sort(), expectedFields.sort());
      assert.equal(JSON.stringify(event).includes("RAW-"), false);
      assert.equal(JSON.stringify(event).includes("MUTATED-"), false);
    }
  });
});

test("full stalled queue drops an event before inspecting its payload", async (t) => {
  const supervisor = await fakeSupervisor(t, { stalled: true });
  const root = await mkdtemp(join(tmpdir(), "ah-opencode-key-"));
  const keyFile = join(root, "auth.key");
  await writeFile(keyFile, authKey, { mode: 0o600 });

  await withEnv({ COMPASS_KEY_FILE: keyFile, COMPASS_SOCKET: supervisor.socketPath }, async () => {
    const hooks = await OpenCodeShadow({});
    try {
      for (let index = 0; index < 256; index += 1) {
        hooks.event({ event: { type: "session.created", sessionID: `session-${index}`, id: `event-${index}` } });
      }
      await waitFor(() => supervisor.requests.length === 1);

      let inspected = 0;
      const previousSessionID = Object.getOwnPropertyDescriptor(Object.prototype, "sessionID");
      Object.defineProperty(Object.prototype, "sessionID", {
        configurable: true,
        get() {
          inspected += 1;
          return "should-not-be-read";
        },
      });
      try {
        assert.equal(hooks.event({ event: { type: "session.updated" } }), undefined);
        assert.equal(inspected, 0);
      } finally {
        if (previousSessionID) Object.defineProperty(Object.prototype, "sessionID", previousSessionID);
        else delete Object.prototype.sessionID;
      }
    } finally {
      supervisor.release();
      await hooks.dispose();
    }
    const appended = supervisor.requests.filter(({ method }) => method === "append").map(({ params }) => params.event);
    const queueSummary = appended.find(({ eventType }) => eventType === "HarnessMetrics");
    assert.ok(queueSummary);
    assert.equal(queueSummary.summary.queueFull, 1);
  });
});

test("pty lifecycle events do not create pty-as-session runs", async (t) => {
  const supervisor = await fakeSupervisor(t);
  const root = await mkdtemp(join(tmpdir(), "ah-opencode-key-"));
  const keyFile = join(root, "auth.key");
  await writeFile(keyFile, authKey, { mode: 0o600 });

  await withEnv({ COMPASS_KEY_FILE: keyFile, COMPASS_SOCKET: supervisor.socketPath }, async () => {
    const hooks = await OpenCodeShadow({});
    hooks.event({ event: {
      id: "pty-created",
      type: "pty.created",
      properties: { info: { id: "pty-created-as-session" } },
    } });
    hooks.event({ event: {
      id: "pty-updated",
      type: "pty.updated",
      properties: { info: { id: "pty-updated-as-session" } },
    } });
    await hooks.dispose();

    assert.deepEqual(supervisor.requests.filter(({ method }) => method === "ensureRun"), []);
    assert.deepEqual(supervisor.requests.filter(({ method }) => method === "append"), []);
  });
});

test("dispose aborts the active request, drops pending work, opens no later connections, and clears its key", async (t) => {
  const supervisor = await fakeSupervisor(t, { stalled: true });
  const root = await mkdtemp(join(tmpdir(), "ah-opencode-key-"));
  const keyFile = join(root, "auth.key");
  await writeFile(keyFile, authKey, { mode: 0o600 });
  const originalFill = Buffer.prototype.fill;
  let cleared = false;
  Buffer.prototype.fill = function fill(value, ...args) {
    if (value === 0 && this.length === authKey.length && this.equals(authKey)) cleared = true;
    return originalFill.call(this, value, ...args);
  };
  t.after(() => { Buffer.prototype.fill = originalFill; });

  await withEnv({ COMPASS_KEY_FILE: keyFile, COMPASS_SOCKET: supervisor.socketPath }, async () => {
    const hooks = await OpenCodeShadow({});
    for (let index = 0; index < 64; index += 1) hooks.event({ event: { type: "session.updated", sessionID: "session", id: `pending-${index}` } });
    await waitFor(() => supervisor.connections === 1);
    const started = Date.now();
    await hooks.dispose();
    assert.ok(Date.now() - started < 250, "dispose did not promptly abort the active request");
    const connectionsAtDispose = supervisor.connections;
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(supervisor.connections, connectionsAtDispose);
    assert.equal(connectionsAtDispose, 1);
    assert.equal(cleared, true);
  });
});

test("host hooks fail open when coalescer.push throws", async (t) => {
  const { keyFile, socketPath } = await fixture(t);
  await withEnv({ COMPASS_KEY_FILE: keyFile, COMPASS_SOCKET: socketPath }, async () => {
    const hooks = await OpenCodeShadow({});
    const originalGetTime = Date.prototype.getTime;
    Date.prototype.getTime = function getTime() {
      throw new Error("synthetic coalescer clock failure");
    };
    try {
      assert.doesNotThrow(() => hooks.event({ event: {
        id: "clock-failure-event", type: "session.created", sessionID: "session",
      } }));
      assert.doesNotThrow(() => hooks["tool.execute.before"](
        { id: "clock-failure-tool", sessionID: "session", tool: "bash" },
        { args: { command: "safe" } },
      ));
    } finally {
      Date.prototype.getTime = originalGetTime;
    }
    await hooks.dispose();
  });
});

test("disabled coalescing drops PTY and all global noise without evicting queued lifecycle events", async (t) => {
  const supervisor = await fakeSupervisor(t, { stalled: true });
  const root = await mkdtemp(join(tmpdir(), "ah-opencode-key-"));
  const keyFile = join(root, "auth.key");
  const configPath = await writeCoalescingConfig({ enabled: false, queueMax: 4 });
  await writeFile(keyFile, authKey, { mode: 0o600 });

  await withEnv({
    COMPASS_KEY_FILE: keyFile,
    COMPASS_SOCKET: supervisor.socketPath,
    COMPASS_COALESCING_CONFIG: configPath,
  }, async () => {
    const hooks = await OpenCodeShadow({});
    for (let index = 0; index < 4; index += 1) {
      hooks.event({ event: { id: `lifecycle-${index}`, type: "session.created", sessionID: `session-${index}` } });
    }
    await waitFor(() => supervisor.requests.length === 1);

    for (const [index, type] of [
      "pty.created", "file.watcher.created", "vcs.commit", "file.edited", "installation.updated",
      "lsp.client.diagnostics", "lsp.updated", "server.connected", "tui.prompt.append",
      "tui.command.execute", "tui.toast.show",
    ].entries()) {
      hooks.event({ event: { id: `noise-${index}`, type, properties: { info: { id: `noise-info-${index}` } } } });
    }

    supervisor.release();
    await hooks.dispose();
    const appended = supervisor.requests.filter(({ method }) => method === "append").map(({ params }) => params.event);
    assert.equal(appended.filter(({ eventType }) => eventType === "SessionStart").length, 4);
    assert.deepEqual(appended.filter(({ eventType }) => [
      "Pty", "FileWatcher", "Vcs", "FileEdit", "InstallationUpdate", "LspDiagnostics", "LspUpdate",
      "ServerConnected", "TuiPromptAppend", "TuiCommandExecute", "TuiToastShow",
    ].includes(eventType)), []);
  });
});

test("disabled, missing, and invalid config still scans global noise for DLP while dropping safe noise", async (t) => {
  const globalNoiseTypes = [
    "pty.created", "file.watcher.created", "vcs.commit", "file.edited", "installation.updated",
    "lsp.client.diagnostics", "lsp.updated", "server.connected", "tui.prompt.append",
    "tui.command.execute", "tui.toast.show",
  ];
  const secret = "Authorization: Bearer b7Qx_2mN9-vR4.kL8sP0";

  for (const mode of ["disabled", "missing", "invalid"]) {
    await t.test(mode, async (t) => {
      const supervisor = await fakeSupervisor(t);
      const root = await mkdtemp(join(tmpdir(), "ah-opencode-config-case-"));
      const keyFile = join(root, "auth.key");
      const configPath = join(root, "coalescing.json");
      await writeFile(keyFile, authKey, { mode: 0o600 });
      if (mode === "disabled") await writeFile(configPath, JSON.stringify({
        schemaVersion: 1,
        enabled: false,
        windowMs: 10_000,
        queueMax: 256,
        preserveLabels: ["lifecycle", "tool", "permission", "error"],
        dlpOverride: true,
      }));
      if (mode === "invalid") await writeFile(configPath, "{ definitely not json");

      await withEnv({
        COMPASS_KEY_FILE: keyFile,
        COMPASS_SOCKET: supervisor.socketPath,
        COMPASS_COALESCING_CONFIG: mode === "missing" ? join(root, "missing.json") : configPath,
      }, async () => {
        const hooks = await OpenCodeShadow({});
        for (const [index, type] of globalNoiseTypes.entries()) {
          hooks.event({ event: {
            id: `dlp-global-${index}`, type,
            properties: { info: { id: `dlp-info-${index}`, text: secret } },
          } });
          hooks.event({ event: {
            id: `safe-global-${index}`, type,
            properties: { info: { id: `safe-info-${index}`, text: "safe" } },
          } });
        }
        await hooks.dispose();

        const appended = supervisor.requests.filter(({ method }) => method === "append").map(({ params }) => params.event);
        const decisions = appended.filter(({ decision }) => decision);
        assert.equal(decisions.length, globalNoiseTypes.length, "every known global DLP event must survive");
        assert.deepEqual(new Set(decisions.map(({ eventID }) => eventID)).size, globalNoiseTypes.length);
        assert.deepEqual(appended.filter(({ eventType, decision }) => [
          "Pty", "FileWatcher", "Vcs", "FileEdit", "InstallationUpdate", "LspDiagnostics", "LspUpdate",
          "ServerConnected", "TuiPromptAppend", "TuiCommandExecute", "TuiToastShow",
        ].includes(eventType) && !decision), []);
        assert.equal(JSON.stringify(appended).includes(secret), false);
      });
    });
  }
});

test("queue-full admission prioritizes DLP decisions and lifecycle events and counts drops", async (t) => {
  const supervisor = await fakeSupervisor(t, { stalled: true });
  const root = await mkdtemp(join(tmpdir(), "ah-opencode-key-"));
  const keyFile = join(root, "auth.key");
  const configPath = await writeCoalescingConfig({ enabled: false, queueMax: 4 });
  await writeFile(keyFile, authKey, { mode: 0o600 });
  const secret = "Authorization: Bearer b7Qx_2mN9-vR4.kL8sP0";

  await withEnv({
    COMPASS_KEY_FILE: keyFile,
    COMPASS_SOCKET: supervisor.socketPath,
    COMPASS_COALESCING_CONFIG: configPath,
  }, async () => {
    const hooks = await OpenCodeShadow({});
    for (let index = 0; index < 4; index += 1) {
      hooks.event({ event: {
        id: `coalescable-${index}`, type: "message.part.updated", sessionID: `coalescable-session-${index}`,
        part: { sessionID: `coalescable-session-${index}`, text: "safe" },
      } });
    }
    await waitFor(() => supervisor.requests.length === 1);

    hooks.event({ event: {
      id: "dlp-must-survive", type: "message.updated", sessionID: "critical-session",
      properties: { info: { id: "critical-message", sessionID: "critical-session", text: secret } },
    } });
    hooks.event({ event: { id: "lifecycle-must-survive", type: "session.deleted", sessionID: "critical-session" } });

    supervisor.release();
    await hooks.dispose();
    const appended = supervisor.requests.filter(({ method }) => method === "append").map(({ params }) => params.event);
    const dlp = appended.find(({ eventType, decision }) => eventType === "MessageUpdate" && decision);
    assert.ok(dlp, "DLP decision must be admitted when the queue is full");
    assert.equal(dlp.decision.ruleIDs[0], "dlp.bearer-token");
    assert.ok(appended.some(({ eventType }) => eventType === "SessionEnd"), "lifecycle event must be admitted when the queue is full");
    const metrics = appended.filter(({ eventType }) => eventType === "HarnessMetrics");
    assert.ok(metrics.length > 0, "queue drops must be reported");
    assert.ok(metrics.some(({ summary }) => (summary.queueFull ?? 0) >= 2), "dropped events must increment queueFull");
  });
});

test("all-priority queue saturation is best-effort and increments global queueFull", async (t) => {
  const supervisor = await fakeSupervisor(t, { stalled: true });
  const root = await mkdtemp(join(tmpdir(), "ah-opencode-key-"));
  const keyFile = join(root, "auth.key");
  const configPath = await writeCoalescingConfig({ enabled: false, queueMax: 3 });
  await writeFile(keyFile, authKey, { mode: 0o600 });

  await withEnv({
    COMPASS_KEY_FILE: keyFile,
    COMPASS_SOCKET: supervisor.socketPath,
    COMPASS_COALESCING_CONFIG: configPath,
  }, async () => {
    const hooks = await OpenCodeShadow({});
    for (let index = 0; index < 3; index += 1) {
      hooks.event({ event: { id: `priority-queued-${index}`, type: "session.created", sessionID: `priority-${index}` } });
    }
    await waitFor(() => supervisor.requests.length === 1);

    for (let index = 0; index < 4; index += 1) {
      assert.doesNotThrow(() => hooks.event({ event: {
        id: `priority-overflow-${index}`, type: "session.deleted", sessionID: `priority-overflow-${index}`,
      } }));
    }

    supervisor.release();
    await hooks.dispose();
    const appended = supervisor.requests.filter(({ method }) => method === "append").map(({ params }) => params.event);
    const metrics = appended.filter(({ eventType }) => eventType === "HarnessMetrics");
    assert.ok(metrics.some(({ runID, summary: value }) => runID !== "" && value.queueFull >= 4), "all-priority drops must be counted globally");
    assert.ok(appended.filter(({ eventType }) => eventType === "SessionEnd").length <= 1, "saturated priority queue must not evict queued priority events");
  });
});

test("HarnessMetrics eviction defers queueFull accounting without exceeding queueMax", async (t) => {
  const queueMax = 2;
  const supervisor = await fakeSupervisor(t, { stalled: true });
  const root = await mkdtemp(join(tmpdir(), "ah-opencode-key-"));
  const keyFile = join(root, "auth.key");
  const configPath = await writeCoalescingConfig({ queueMax });
  await writeFile(keyFile, authKey, { mode: 0o600 });

  await withEnv({
    COMPASS_KEY_FILE: keyFile,
    COMPASS_SOCKET: supervisor.socketPath,
    COMPASS_COALESCING_CONFIG: configPath,
  }, async () => {
    const hooks = await OpenCodeShadow({});
    hooks.event({ event: { id: "active-lifecycle", type: "session.created", sessionID: "active-session" } });
    await waitFor(() => supervisor.requests.length === 1);
    hooks.event({ event: { id: "evictable-event", type: "message.part.removed", sessionID: "evictable-session" } });
    hooks.event({ event: { id: "global-summary-input", type: "file.edited", properties: { info: { id: "global-info" } } } });

    const disposing = hooks.dispose();
    supervisor.release();
    await disposing;

    const appended = supervisor.requests.filter(({ method }) => method === "append").map(({ params }) => params.event);
    const metrics = appended.filter(({ eventType }) => eventType === "HarnessMetrics");
    assert.ok(metrics.length > 0, "summary admission must produce HarnessMetrics");
    assert.equal(metrics.reduce((total, { summary }) => total + summary.queueFull, 0), 1, "evicting a raw event for HarnessMetrics must be counted");
    assert.ok(appended.length <= queueMax, `retained ${appended.length} events with queueMax=${queueMax}`);
  });
});

test("dispose flushes summaries and queue-full metrics and cancels coalescer timer after worker timeout", async (t) => {
  const supervisor = await fakeSupervisor(t, { stalled: true });
  const root = await mkdtemp(join(tmpdir(), "ah-opencode-key-"));
  const keyFile = join(root, "auth.key");
  const configPath = await writeCoalescingConfig({ windowMs: 10_000 });
  await writeFile(keyFile, authKey, { mode: 0o600 });
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const timers = [];
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (delay === 100) {
      const handle = { callback: () => callback(...args), unref() {} };
      timers.push({ delay, handle, cleared: false });
      return handle;
    }
    const handle = realSetTimeout(callback, delay, ...args);
    timers.push({ delay, handle, cleared: false });
    return handle;
  };
  globalThis.clearTimeout = (handle) => {
    const entry = timers.find((timer) => timer.handle === handle);
    if (entry) {
      entry.cleared = true;
      if (entry.delay === 100) return;
    }
    return realClearTimeout(handle);
  };
  t.after(() => {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  });

  await withEnv({
    COMPASS_KEY_FILE: keyFile,
    COMPASS_SOCKET: supervisor.socketPath,
    COMPASS_COALESCING_CONFIG: configPath,
  }, async () => {
    const hooks = await OpenCodeShadow({});
    for (let index = 0; index < 256; index += 1) {
      hooks.event({ event: { id: `timeout-lifecycle-${index}`, type: "session.created", sessionID: `timeout-${index}` } });
    }
    await waitFor(() => supervisor.requests.length === 1);
    hooks.event({ event: {
      id: "timeout-global-noise", type: "file.edited", properties: { info: { id: "global-info" } },
    } });
    hooks.event({ event: {
      id: "timeout-summary", type: "message.updated", sessionID: "timeout-summary-session",
      properties: { info: { id: "summary-message", sessionID: "timeout-summary-session", text: "safe" } },
    } });

    const disposing = hooks.dispose();
    const disposeTimer = await (async () => {
      await waitFor(() => timers.some(({ delay }) => delay === 100));
      return timers.find(({ delay }) => delay === 100);
    })();
    disposeTimer.handle.callback();
    supervisor.release();
    await disposing;

    const appended = supervisor.requests.filter(({ method }) => method === "append").map(({ params }) => params.event);
    const metrics = appended.filter(({ eventType }) => eventType === "HarnessMetrics");
    assert.ok(metrics.some(({ summary }) => summary.messageUpdate === 1), "summary must flush after timeout");
    assert.ok(metrics.some(({ summary }) => summary.queueFull === 1), "queueFull must flush after timeout");
    const coalescerTimers = timers.filter(({ delay }) => delay === 10_000);
    assert.ok(coalescerTimers.length > 0);
    assert.ok(coalescerTimers.every(({ cleared }) => cleared), "dispose must cancel the summary timer after timeout");
  });
});

test("keeps a summary pending until append ACK and retries failed or aborted appends", async (t) => {
  for (const abortAppend of [false, true]) {
    await t.test(abortAppend ? "aborted append" : "failed append", async (t) => {
      const supervisor = await fakeSupervisor(t, { appendFailures: 1, abortAppend });
      const root = await mkdtemp(join(tmpdir(), "ah-opencode-key-"));
      const keyFile = join(root, "auth.key");
      const configPath = await writeCoalescingConfig();
      await writeFile(keyFile, authKey, { mode: 0o600 });

      await withEnv({
        COMPASS_KEY_FILE: keyFile,
        COMPASS_SOCKET: supervisor.socketPath,
        COMPASS_COALESCING_CONFIG: configPath,
      }, async () => {
        const hooks = await OpenCodeShadow({});
        hooks.event({ event: {
          id: `summary-${abortAppend ? "abort" : "failure"}`,
          type: "message.updated",
          sessionID: "summary-session",
          properties: { info: { id: "summary-message", sessionID: "summary-session", text: "safe" } },
        } });
        await hooks.dispose();

        const attempts = supervisor.requests.filter(({ method, params }) => method === "append" && params.event.eventType === "HarnessMetrics");
        const acknowledgements = supervisor.ackedAppends.filter(({ eventType }) => eventType === "HarnessMetrics");
        assert.ok(attempts.length >= 2, "a failed/aborted append must be retried");
        assert.equal(acknowledgements.length, 1, "the summary must be retained until one append is acknowledged");
      });
    });
  }
});

test("real message.part.delta envelopes coalesce and DLP override preserves the secret-bearing delta", async (t) => {
  const { keyFile, socketPath, ledger } = await fixture(t);
  const configPath = await writeCoalescingConfig();
  const secret = "Authorization: Bearer b7Qx_2mN9-vR4.kL8sP0";
  const safe = (id, delta) => ({
    id,
    type: "message.part.delta",
    properties: { part: { id: "part-1", sessionID: "delta-session", messageID: "message-1", delta } },
  });
  await withEnv({
    COMPASS_KEY_FILE: keyFile,
    COMPASS_SOCKET: socketPath,
    COMPASS_COALESCING_CONFIG: configPath,
  }, async () => {
    const hooks = await OpenCodeShadow({});
    await hooks.event({ event: safe("delta-safe-1", "safe") });
    await hooks.event({ event: safe("delta-safe-2", "still safe") });
    await hooks.event({ event: safe("delta-secret", secret) });
     await hooks.dispose();

     const runID = translateOpenCodeEvent(safe("baseline", "safe"), { authKey }).runID;
     const events = ledger.listEvents(runID);
     assert.equal(events.filter((event) => event.eventType === "MessagePartDelta" && event.decision).length, 1);
     assert.equal(events.find(({ eventType, decision }) => eventType === "MessagePartDelta" && decision)?.decision.ruleIDs[0], "dlp.bearer-token");
     assert.equal(events.find(({ eventType }) => eventType === "HarnessMetrics")?.summary.messagePartDelta, 2);
   });
 });

// RED TESTS for new experimental.chat.system.transform contract:
// - Hook injects via output.system array (not chat.message Part injection)
// - Zero hot-path I/O (no fs/git/socket)
// - Fail-open wrapper (never throws into host)
// - Redaction wired (redactText from src/dlp/redact.mjs)
// - Occurrence tracking with DISTINCT occurrenceIDs → DISTINCT eventID/dedupeKey

test("experimental.chat.system.transform hook registered, NO chat.message hook", async (t) => {
  const { keyFile, socketPath } = await fixture(t);
  await withEnv({ COMPASS_KEY_FILE: keyFile, COMPASS_SOCKET: socketPath }, async () => {
    const hooks = await OpenCodeShadow({});
    assert.equal(typeof hooks["experimental.chat.system.transform"], "function", "experimental.chat.system.transform hook must exist");
    assert.equal(typeof hooks["chat.message"], "undefined", "chat.message hook must NOT exist (replaced by system.transform)");
    await hooks.dispose();
  });
});

test("experimental.chat.system.transform with cold cache pushes nothing and records nothing", async (t) => {
  const { keyFile, socketPath } = await fixture(t);
  await withEnv({ COMPASS_KEY_FILE: keyFile, COMPASS_SOCKET: socketPath }, async () => {
    const recordInjectionCalls = [];
    const hooks = await OpenCodeShadow({
      _groundingCache: {
        snapshot: () => null,
        recordInjection: () => { recordInjectionCalls.push({}); },
        noteToolActivity: () => {},
        stop: () => {},
      },
    });

    const output = { system: [] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "test", messageID: "msg-1" }, output);

    assert.equal(output.system.length, 0, "with cold cache, output.system must remain empty");
    assert.equal(recordInjectionCalls.length, 0, "with cold cache, recordInjection must not be called");
    assert.equal(Object.hasOwn(output, "parts"), false, "output must not have parts property");
    await hooks.dispose();
  });
});

test("experimental.chat.system.transform with warmed cache pushes brief onto output.system and records", async (t) => {
  const { keyFile, socketPath } = await fixture(t);
  await withEnv({ COMPASS_KEY_FILE: keyFile, COMPASS_SOCKET: socketPath }, async () => {
    const recordInjectionCalls = [];
    const briefText = "Project context from vault";
    const snapshot = {
      brief: briefText,
      metadata: {
        sources: [{ kind: "project-notes", ref: "init/overview.md" }],
        bytes: 256,
        approxTokens: 64,
        matchReason: "ticket",
        commentFiles: 1,
        latencyMs: 20,
      },
    };

    const hooks = await OpenCodeShadow({
      _groundingCache: {
        snapshot: () => snapshot,
        recordInjection: () => { recordInjectionCalls.push({}); },
        noteToolActivity: () => {},
        stop: () => {},
      },
    });

    const runtimeSystem = [];
    const output = { system: runtimeSystem };
    await hooks["experimental.chat.system.transform"]({ sessionID: "test", messageID: "msg-1" }, output);

    assert.equal(runtimeSystem.length, 1, "with warmed cache, brief must be pushed onto the aliased system array");
    assert.equal(runtimeSystem[0], briefText, "system array[0] must be the snapshot.brief string");
    assert.equal(output.system, runtimeSystem, "system.transform must preserve the runtime-owned array");
    assert.equal(recordInjectionCalls.length, 1, "recordInjection must be called exactly once");
    assert.equal(Object.hasOwn(output, "parts"), false, "output must not have parts property");
    await hooks.dispose();
  });
});

test("experimental.chat.system.transform fails open without creating or replacing a non-array system", async (t) => {
  const { keyFile, socketPath } = await fixture(t);
  await withEnv({ COMPASS_KEY_FILE: keyFile, COMPASS_SOCKET: socketPath }, async () => {
    const recordInjectionCalls = [];
    const snapshot = { brief: "Project context", metadata: {} };
    const hooks = await OpenCodeShadow({
      _groundingCache: {
        snapshot: () => snapshot,
        recordInjection: () => { recordInjectionCalls.push({}); },
        noteToolActivity: () => {},
        stop: () => {},
      },
    });

    const outputs = [{}, { system: undefined }, { system: "host-owned system" }];
    for (const output of outputs) {
      const hadSystem = Object.hasOwn(output, "system");
      const originalSystem = output.system;
      assert.doesNotThrow(() => {
        hooks["experimental.chat.system.transform"]({ sessionID: "test", messageID: "msg-1" }, output);
      });
      assert.equal(Object.hasOwn(output, "system"), hadSystem, "fail-open hook must not create a system property");
      assert.equal(output.system, originalSystem, "fail-open hook must not replace non-array system state");
    }
    assert.equal(recordInjectionCalls.length, 0, "nothing injected means recordInjection must not be called");
    await hooks.dispose();
  });
});

test("experimental.chat.system.transform zero hot-path I/O with cold cache", async (t) => {
  const { keyFile, socketPath } = await fixture(t);
  const spies = { fsReadFile: 0, fsStat: 0, fsReaddir: 0, gitExecFile: 0, socketWrite: 0 };

  await withEnv({ COMPASS_KEY_FILE: keyFile, COMPASS_SOCKET: socketPath }, async () => {
    const spiedFs = {
      async readFile() { spies.fsReadFile += 1; return ""; },
      async stat() { spies.fsStat += 1; return { mtimeMs: 0, size: 0 }; },
      async readdir() { spies.fsReaddir += 1; return []; },
    };
    const spiedGit = {
      async execFile() { spies.gitExecFile += 1; return { stdout: "" }; },
    };
    const hooks = await OpenCodeShadow({
      _createGroundingCache: ({ directory, worktree, loadConfig, redact }) => createGroundingCache({
        directory, worktree, loadConfig, redact, fs: spiedFs, git: spiedGit,
      }),
    });

    const output = { system: [] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "test", messageID: "msg-1" }, output);

    assert.equal(spies.fsReadFile, 0, "hot path must not call fs.readFile");
    assert.equal(spies.fsStat, 0, "hot path must not call fs.stat");
    assert.equal(spies.fsReaddir, 0, "hot path must not call fs.readdir");
    assert.equal(spies.gitExecFile, 0, "hot path must not call git.execFile");
    await hooks.dispose();
  });
});

test("experimental.chat.system.transform zero hot-path I/O with warmed cache", async (t) => {
  const supervisor = await fakeSupervisor(t);
  const root = await mkdtemp(join(tmpdir(), "ah-opencode-warm-key-"));
  const keyFile = join(root, "auth.key");
  await writeFile(keyFile, authKey, { mode: 0o600 });
  const spies = { fsReadFile: 0, fsStat: 0, fsReaddir: 0, gitExecFile: 0, socketWrite: 0 };

  await withEnv({ COMPASS_KEY_FILE: keyFile, COMPASS_SOCKET: supervisor.socketPath }, async () => {
    const clock = fakeClock();
    const timers = fakeTimers(clock);
    let cache;
    const spiedFs = {
      async readFile(path) {
        spies.fsReadFile += 1;
        return path.endsWith("overview.md") ? "PROJ-123 grounding context" : "";
      },
      async stat() { spies.fsStat += 1; return { mtimeMs: 1, size: 32 }; },
      async readdir(path) {
        spies.fsReaddir += 1;
        if (path === "/worktree/.compass/notes") return [{ name: "initiative-x", isDirectory: () => true }];
        if (path === "/worktree/.compass/notes/initiative-x") return [{ name: "overview.md", isDirectory: () => false }];
        return [];
      },
    };
    spiedFs.realpath = async path => path;
    spiedFs.lstat = async path => {
      spies.fsStat++;
      return { size: 32, ino: path, dev: 1, isSymbolicLink: () => false,
        isFile: () => path.endsWith(".md"), isDirectory: () => !path.endsWith(".md") };
    };
    spiedFs.opendir = async path => {
      const entries = await spiedFs.readdir(path);
      return (async function* () { for (const entry of entries) yield {
        ...entry, isSymbolicLink: () => false, isFile: () => !entry.isDirectory(),
      }; })();
    };
    spiedFs.open = async path => ({
      stat: () => spiedFs.lstat(path),
      async read(buffer, offset, length, position) {
        if (position > 0) return { bytesRead: 0 };
        return { bytesRead: Buffer.from(await spiedFs.readFile(path)).copy(buffer, offset, position, position + length) };
      },
      async close() {},
    });
    const spiedGit = {
      async execFile(_command, args) {
        spies.gitExecFile += 1;
        if (args.includes("--show-current")) return { stdout: "feat/PROJ-123-grounding\n" };
        if (args.includes("--show-toplevel")) return { stdout: "/worktree\n" };
        if (args.includes("--git-common-dir")) return { stdout: "/worktree/.git\n" };
        if (args.includes("--git-path")) return { stdout: "/worktree/.git/HEAD\n" };
        if (args.includes("rev-parse")) return { stdout: "head-1\n" };
        return { stdout: "" };
      },
    };

    const hooks = await OpenCodeShadow({
      directory: "/vault",
      worktree: "/worktree",
      _createGroundingCache: ({ directory, worktree, redact }) => {
        cache = createGroundingCache({
          directory, worktree, redact, notesDir: "",
          loadConfig: async () => ({
            schemaVersion: 1,
            enabled: true,
            tokenBudget: 256,
            deadlineMs: 100,
            sources: ["project-notes"],
          }),
          fs: spiedFs,
          git: spiedGit,
          timers,
          clock,
        });
        return cache;
      },
    });

    await timers.advance(60_000);
    await waitFor(() => cache.snapshot()?.brief);
    const warmedSnapshot = cache.snapshot();
    assert.ok(warmedSnapshot?.brief, "cache must be warmed before measuring hot path");
    const baseline = { ...spies, socketRequests: supervisor.requests.length };

    const output = { system: [] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "test", messageID: "msg-1" }, output);

    assert.equal(spies.fsReadFile - baseline.fsReadFile, 0, "hot path with warmed cache must not call fs.readFile");
    assert.equal(spies.fsStat - baseline.fsStat, 0, "hot path with warmed cache must not call fs.stat");
    assert.equal(spies.fsReaddir - baseline.fsReaddir, 0, "hot path with warmed cache must not call fs.readdir");
    assert.equal(spies.gitExecFile - baseline.gitExecFile, 0, "hot path with warmed cache must not call git.execFile");
    assert.equal(supervisor.requests.length - baseline.socketRequests, 0, "hot path must not enqueue telemetry directly");
    await hooks.dispose();
  });
});

test("experimental.chat.system.transform fail-open when snapshot() throws", async (t) => {
  const { keyFile, socketPath } = await fixture(t);
  await withEnv({ COMPASS_KEY_FILE: keyFile, COMPASS_SOCKET: socketPath }, async () => {
    const hooks = await OpenCodeShadow({
      _groundingCache: {
        snapshot: () => { throw new Error("snapshot failure"); },
        recordInjection: () => { throw new Error("recordInjection failure"); },
        noteToolActivity: () => {},
        stop: () => {},
      },
    });

    const output = { system: [] };
    assert.doesNotThrow(() => {
      hooks["experimental.chat.system.transform"]({ sessionID: "test", messageID: "msg-1" }, output);
    }, "system.transform must not throw even if snapshot() fails");
    assert.equal(output.system.length, 0, "output.system must remain usable after snapshot failure");
    await hooks.dispose();
  });
});

test("experimental.chat.system.transform fail-open when recordInjection() throws", async (t) => {
  const { keyFile, socketPath } = await fixture(t);
  await withEnv({ COMPASS_KEY_FILE: keyFile, COMPASS_SOCKET: socketPath }, async () => {
    const snapshot = {
      brief: "Project context",
      metadata: {
        sources: [{ kind: "project-notes", ref: "init/overview.md" }],
        bytes: 100,
        approxTokens: 25,
        matchReason: "ticket",
        commentFiles: 1,
        latencyMs: 10,
      },
    };

    const hooks = await OpenCodeShadow({
      _groundingCache: {
        snapshot: () => snapshot,
        recordInjection: () => { throw new Error("recordInjection failure"); },
        noteToolActivity: () => {},
        stop: () => {},
      },
    });

    const output = { system: [] };
    assert.doesNotThrow(() => {
      hooks["experimental.chat.system.transform"]({ sessionID: "test", messageID: "msg-1" }, output);
    }, "system.transform must not throw even if recordInjection() fails");
    // Even though recordInjection threw, the brief should still be pushed
    assert.equal(output.system.length, 1, "output.system must be populated even if recordInjection fails");
    assert.equal(output.system[0], snapshot.brief);
    await hooks.dispose();
  });
});

test("experimental.chat.system.transform pushes snapshot.brief VERBATIM (no hot-path redaction) and calls recordInjection", async (t) => {
  const { keyFile, socketPath } = await fixture(t);

  await withEnv({ COMPASS_KEY_FILE: keyFile, COMPASS_SOCKET: socketPath }, async () => {
    const recordInjectionCalls = [];
    const redactedBrief = "Project context [REDACTED:bearer-token]. Verify before using.";
    const snapshot = {
      brief: redactedBrief,
      metadata: {
        sources: [{ kind: "project-notes", ref: "init/overview.md" }],
        bytes: 256,
        approxTokens: 64,
        matchReason: "ticket",
        commentFiles: 1,
        latencyMs: 20,
      },
    };

    const hooks = await OpenCodeShadow({
      _groundingCache: {
        snapshot: () => snapshot,
        recordInjection: () => { recordInjectionCalls.push({}); },
        noteToolActivity: () => {},
        stop: () => {},
      },
    });

    const output = { system: [] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "test", messageID: "msg-1" }, output);

    assert.equal(output.system.length, 1, "brief must be injected onto output.system");
    assert.equal(output.system[0], redactedBrief, "hot-path hook must push snapshot.brief EXACTLY as provided (no transformation)");
    assert.equal(recordInjectionCalls.length, 1, "recordInjection must be called exactly once");
    await hooks.dispose();
  });
});

test("legacy bare metadata drains retain content-based identity", async (t) => {
  const supervisor = await fakeSupervisor(t);
  const root = await mkdtemp(join(tmpdir(), "ah-opencode-occurrence-key-"));
  const keyFile = join(root, "auth.key");
  await writeFile(keyFile, authKey, { mode: 0o600 });
  const timerControl = captureGlobalTimer(30_000);
  t.after(timerControl.restore);

  const metadata = {
    sources: [{ kind: "project-notes", ref: "init/overview.md" }],
    bytes: 256,
    approxTokens: 64,
    matchReason: "ticket",
    commentFiles: 1,
    latencyMs: 12,
  };

  await withEnv({ COMPASS_KEY_FILE: keyFile, COMPASS_SOCKET: supervisor.socketPath }, async () => {
    let callCount = 0;
    const drainedMetadata = [];

    const hooks = await OpenCodeShadow({
      _groundingCache: {
        snapshot: () => ({ brief: "context", metadata }),
        recordInjection: () => { callCount += 1; },
        noteToolActivity: () => {},
        drainMetadata: () => {
          // Legacy cache shape contains bare metadata without occurrence IDs.
          const result = [];
          if (callCount > 0) result.push({ ...metadata });
          if (callCount > 1) result.push({ ...metadata });
          return result;
        },
        stop: () => {},
      },
    });

    const output = { system: [] };
    // First injection
    await hooks["experimental.chat.system.transform"]({ sessionID: "test", messageID: "msg-1" }, output);
    // Second injection with same message (simulates two distinct occurrences of same metadata)
    await hooks["experimental.chat.system.transform"]({ sessionID: "test", messageID: "msg-2" }, output);

    assert.equal(callCount, 2, "recordInjection must be called twice");

    // Trigger drain
    assert.equal(timerControl.captured.length, 1, "grounding drain timer must be scheduled");
    await timerControl.captured[0].handle.callback();
    await waitFor(() => supervisor.requests.some(({ method, params }) => method === "append" && params.event.eventType === "GroundingInjection"));

    const events = supervisor.requests
      .filter(({ method }) => method === "append")
      .map(({ params }) => params.event)
      .filter(({ eventType }) => eventType === "GroundingInjection");

    assert.ok(events.length >= 2, `must have at least 2 GroundingInjection events, got ${events.length}`);
    const eventIDs = new Set(events.slice(0, 2).map(e => e.eventID));
    assert.equal(eventIDs.size, 1, "same metadata → same eventID (metadata-based identity)");
    const dedupeKeys = new Set(events.slice(0, 2).map(e => e.dedupeKey));
    assert.equal(dedupeKeys.size, 1, "same metadata → same dedupeKey (metadata-based dedupe)");

    await hooks.dispose();
  });
});

test("tool.execute.after still calls noteToolActivity on grounding cache", async (t) => {
  const { keyFile, socketPath, ledger } = await fixture(t);

  await withEnv({ COMPASS_KEY_FILE: keyFile, COMPASS_SOCKET: socketPath }, async () => {
    const noteToolActivityCalls = [];
    const hooks = await OpenCodeShadow({
      _groundingCache: {
        snapshot: () => null,
        noteToolActivity: () => { noteToolActivityCalls.push({}); },
        recordInjection: () => {},
        stop: () => {},
      },
    });

    const toolInput = { sessionID: "tool-session", tool: "bash", callID: "call-123" };
    await hooks["tool.execute.after"](toolInput, { result: "output" });
    await hooks.dispose();

    assert.ok(noteToolActivityCalls.length > 0, "tool.execute.after must invoke noteToolActivity on grounding cache");
  });
});

test("dispose() calls stop() on grounding cache synchronously", async (t) => {
  const { keyFile, socketPath } = await fixture(t);

  await withEnv({ COMPASS_KEY_FILE: keyFile, COMPASS_SOCKET: socketPath }, async () => {
    let stopCalled = false;
    const hooks = await OpenCodeShadow({
      _groundingCache: {
        snapshot: () => null,
        recordInjection: () => {},
        noteToolActivity: () => {},
        stop: () => { stopCalled = true; },
      },
    });

    await hooks.dispose();

    assert.equal(stopCalled, true, "dispose() must call stop() on grounding cache");
  });
});

test("tool.execute.after enqueues telemetry unchanged AND calls noteToolActivity on grounding cache", async (t) => {
  const { keyFile, socketPath, ledger } = await fixture(t);

  await withEnv({ COMPASS_KEY_FILE: keyFile, COMPASS_SOCKET: socketPath }, async () => {
    const noteToolActivityCalls = [];
    const hooks = await OpenCodeShadow({
      _groundingCache: {
        snapshot: () => null,
        noteToolActivity: () => {
          noteToolActivityCalls.push({});
        },
      },
    });

    const toolInput = { sessionID: "tool-session", tool: "bash", callID: "call-123" };
    await hooks["tool.execute.after"](toolInput, { result: "output" });
    await hooks.dispose();

    // tool.execute.after MUST call noteToolActivity if grounding cache provides it
    assert.ok(noteToolActivityCalls.length > 0, "tool.execute.after must invoke noteToolActivity on grounding cache");
  });
});

test("dispose() cancels grounding background timer synchronously", async (t) => {
  const { keyFile, socketPath } = await fixture(t);

  await withEnv({ COMPASS_KEY_FILE: keyFile, COMPASS_SOCKET: socketPath }, async () => {
    let timerStopped = false;
    const hooks = await OpenCodeShadow({
      _groundingCache: {
        snapshot: () => null,
        noteToolActivity: () => {},
        // Mock stop to track timer cleanup
        stop: () => { timerStopped = true; },
      },
    });

    await hooks.dispose();

    assert.equal(timerStopped, true, "dispose() must call stop() on grounding cache synchronously");
  });
});

test("GroundingInjection drain persists one closed metadata event and no raw context", async (t) => {
  const supervisor = await fakeSupervisor(t);
  const root = await mkdtemp(join(tmpdir(), "ah-opencode-grounding-key-"));
  const keyFile = join(root, "auth.key");
  await writeFile(keyFile, authKey, { mode: 0o600 });
  const timerControl = captureGlobalTimer(30_000);
  t.after(timerControl.restore);
  const metadata = {
    sources: [{ kind: "project-notes", ref: "initiative-x/overview.md" }],
    bytes: 256,
    approxTokens: 64,
    matchReason: "ticket",
    commentFiles: 1,
    latencyMs: 12,
  };

  await withEnv({ COMPASS_KEY_FILE: keyFile, COMPASS_SOCKET: supervisor.socketPath }, async () => {
    const hooks = await OpenCodeShadow({
      _groundingCache: {
        snapshot: () => null,
        noteToolActivity: () => {},
        drainMetadata: () => [metadata],
        stop: () => {},
      },
    });

    assert.equal(timerControl.captured.length, 1, "server must schedule the grounding drain timer");
    await timerControl.captured[0].handle.callback();
    await waitFor(() => supervisor.requests.some(({ method, params }) => method === "append" && params.event.eventType === "GroundingInjection"));

    const events = supervisor.requests
      .filter(({ method }) => method === "append")
      .map(({ params }) => params.event)
      .filter(({ eventType }) => eventType === "GroundingInjection");
    assert.equal(events.length, 1, "a drained metadata entry must enqueue one GroundingInjection event");
    assert.deepEqual(Object.keys(events[0].metadata).sort(), [
      "approxTokens", "bytes", "commentFiles", "latencyMs", "matchReason", "sources",
    ]);
    assert.deepEqual(Object.keys(events[0].metadata.sources[0]).sort(), ["kind", "ref"]);
    const serialized = JSON.stringify(events[0]);
    for (const forbidden of ["briefText", "rawBrief", "vaultContent", "commentText", "cwd", "branch", process.cwd(), process.env.HOME].filter(Boolean)) {
      assert.equal(serialized.includes(forbidden), false, `GroundingInjection event must not contain ${forbidden}`);
    }
    await hooks.dispose();
  });
});

test("default grounding drain changes its retention epoch across UTC months", async (t) => {
  const supervisor = await fakeSupervisor(t);
  const root = await mkdtemp(join(tmpdir(), "ah-opencode-month-"));
  const keyFile = join(root, "auth.key");
  await writeFile(keyFile, authKey, { mode: 0o600 });
  const timerControl = captureGlobalTimer(30_000);
  t.after(timerControl.restore);
  const ActualDate = globalThis.Date;
  let month = "2026-09-30T23:59:59Z";
  let occurrence = 0;
  globalThis.Date = class extends ActualDate {
    constructor(...args) { super(...(args.length ? args : [month])); }
  };
  t.after(() => { globalThis.Date = ActualDate; });
  await withEnv({ COMPASS_KEY_FILE: keyFile, COMPASS_SOCKET: supervisor.socketPath }, async () => {
    const hooks = await OpenCodeShadow({ _groundingCache: {
      start() {}, stop() {},
      drainMetadata: () => [{ metadata: { sources: [], matchReason: "none" }, occurrenceID: `month-${++occurrence}` }],
    } });
    await timerControl.captured[0].handle.callback();
    await waitFor(() => supervisor.requests.filter(({ method }) => method === "append").length === 1);
    month = "2026-10-01T00:00:00Z";
    await timerControl.captured[1].handle.callback();
    await waitFor(() => supervisor.requests.filter(({ method }) => method === "append").length === 2);
    const events = supervisor.requests.filter(({ method }) => method === "append").map(({ params }) => params.event);
    assert.notEqual(events[0].runID, events[1].runID);
    await hooks.dispose();
  });
});

test("dispose drains short-session grounding once and rejects late hooks", async (t) => {
  const supervisor = await fakeSupervisor(t);
  const root = await mkdtemp(join(tmpdir(), "compass-final-drain-"));
  const keyFile = join(root, "key");
  await writeFile(keyFile, authKey, { mode: 0o600 });
  const timerControl = captureGlobalTimer(30_000);
  t.after(timerControl.restore);
  await withEnv({ COMPASS_KEY_FILE: keyFile, COMPASS_SOCKET: supervisor.socketPath }, async () => {
    const entries = []; let drains = 0; let activities = 0;
    const hooks = await OpenCodeShadow({ _groundingCache: {
      start() {}, stop() {}, snapshot: () => ({ brief: "brief" }),
      recordInjection() { entries.push(null, { metadata: { sources: [], matchReason: "none" }, occurrenceID: "short" }); },
      drainMetadata() { drains++; return entries.splice(0); }, noteToolActivity() { activities++; },
    } });
    hooks["experimental.chat.system.transform"]({}, { system: [] });
    const first = hooks.dispose(); const second = hooks.dispose();
    assert.equal(first, second);
    await first;
    assert.equal(drains, 1);
    assert.equal(supervisor.ackedAppends.filter(e => e.eventType === "GroundingInjection").length, 1);
    const output = { system: [] };
    hooks["experimental.chat.system.transform"]({}, output);
    hooks["tool.execute.after"]();
    timerControl.captured[0].handle.callback();
    assert.deepEqual(output.system, []);
    assert.equal(activities, 0);
    assert.equal(drains, 1);
    assert.equal(timerControl.captured.length, 1);
    await hooks.dispose();
  });
});

test("native-shaped plugin rotates sessionless observations in the same process", async (t) => {
  const supervisor = await fakeSupervisor(t);
  const root = await mkdtemp(join(tmpdir(), "compass-native-month-"));
  const keyFile = join(root, "key");
  await writeFile(keyFile, authKey, { mode: 0o600 });
  const ActualDate = globalThis.Date;
  let instant = "2026-09-30T23:59:59Z";
  globalThis.Date = class extends ActualDate { constructor(...args) { super(...(args.length ? args : [instant])); } };
  t.after(() => { globalThis.Date = ActualDate; });
  await withEnv({ COMPASS_KEY_FILE: keyFile, COMPASS_SOCKET: supervisor.socketPath }, async () => {
    const hooks = await OpenCodeShadow({ directory: root, worktree: root, client: {}, project: {}, serverUrl: new URL("http://localhost"), $: {} });
    hooks.event({ event: { type: "session.error", id: "same" } });
    await waitFor(() => supervisor.ackedAppends.length === 1);
    instant = "2026-10-01T00:00:00Z";
    hooks.event({ event: { type: "session.error", id: "same" } });
    await hooks.dispose();
    assert.equal(supervisor.ackedAppends.length, 2);
    assert.notEqual(supervisor.ackedAppends[0].runID, supervisor.ackedAppends[1].runID);
    assert.notEqual(supervisor.ackedAppends[0].eventID, supervisor.ackedAppends[1].eventID);
  });
});

test("server grounding drain preserves distinct occurrences and stable retry identities", async (t) => {
  const supervisor = await fakeSupervisor(t);
  const root = await mkdtemp(join(tmpdir(), "compass-occurrences-"));
  const keyFile = join(root, "key");
  await writeFile(keyFile, authKey, { mode: 0o600 });
  await withEnv({ COMPASS_KEY_FILE: keyFile, COMPASS_SOCKET: supervisor.socketPath }, async () => {
    const metadata = { sources: [], matchReason: "none" };
    const entries = ["first", "second", "first"].map(occurrenceID => ({ metadata, occurrenceID }));
    const hooks = await OpenCodeShadow({ _groundingCache: { start() {}, stop() {}, drainMetadata: () => entries.splice(0) } });
    await hooks.dispose();
    const events = supervisor.ackedAppends;
    assert.equal(events.length, 3);
    for (const field of ["eventID", "dedupeKey"]) {
      assert.notEqual(events[0][field], events[1][field]);
      assert.equal(events[0][field], events[2][field]);
    }
  });
});

test("final grounding drain remains bounded with a stalled supervisor", async (t) => {
  const supervisor = await fakeSupervisor(t, { stalled: true });
  const root = await mkdtemp(join(tmpdir(), "compass-stalled-drain-"));
  const keyFile = join(root, "key");
  await writeFile(keyFile, authKey, { mode: 0o600 });
  await withEnv({ COMPASS_KEY_FILE: keyFile, COMPASS_SOCKET: supervisor.socketPath }, async () => {
    const entries = [{ metadata: { sources: [], matchReason: "none" }, occurrenceID: "stalled" }];
    const hooks = await OpenCodeShadow({ _groundingCache: { start() {}, stop() {}, drainMetadata: () => entries.splice(0) } });
    const started = performance.now();
    await Promise.all([hooks.dispose(), hooks.dispose()]);
    assert.ok(performance.now() - started < 300);
    assert.equal(supervisor.requests.length, 1);
  });
});
