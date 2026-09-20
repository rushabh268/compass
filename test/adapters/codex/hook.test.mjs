import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { translateCodexHook } from "../../../adapters/codex/translate.mjs";
import { createResponse, encodeFrame, FrameDecoder } from "../../../src/protocol/rpc.mjs";
import { openLedger } from "../../../src/state/ledger.mjs";
import { request } from "../../../src/supervisor/client.mjs";
import { startSupervisor } from "../../../src/supervisor/server.mjs";

const hook = fileURLToPath(new URL("../../../adapters/codex/hook.mjs", import.meta.url));
const authKey = Buffer.alloc(32, 0x6b);
const silentExit = { code: 0, signal: null, stdout: "", stderr: "" };

function payload(overrides = {}) {
  return {
    hook_event_name: "PostToolUse", session_id: "private-session", turn_id: "private-turn",
    tool_use_id: "private-tool-use", tool_name: "Bash",
    cwd: "/private/project", transcript_path: "/private/transcript.jsonl",
    tool_input: { command: "printf private-input" }, tool_response: "private-response",
    ...overrides,
  };
}

function launchHook(t, env) {
  const childEnv = { ...process.env, AGENT_HARNESS_SOCKET: undefined, AGENT_HARNESS_KEY_FILE: undefined, ...env };
  delete childEnv.NODE_OPTIONS;
  for (const key of Object.keys(childEnv)) if (childEnv[key] === undefined) delete childEnv[key];
  const started = performance.now();
  const child = spawn(process.execPath, [hook], { env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.on("error", () => {}); // Oversized input may close the pipe while the parent is still writing.
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 4_000);
  t.after(() => { clearTimeout(watchdog); if (child.exitCode === null) child.kill("SIGKILL"); });
  const done = once(child, "close").then(([code, signal]) => {
    clearTimeout(watchdog);
    return { result: { code, signal, stdout, stderr }, elapsedMs: performance.now() - started };
  });
  return { child, done };
}

async function runHook(t, input, env) {
  const { child, done } = launchHook(t, env);
  child.stdin.end(input);
  return done;
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ah-cx-"));
  const keyFile = join(root, "auth.key");
  const socketPath = join(root, "private", "supervisor.sock");
  const ledgerDir = join(root, "ledger");
  const ledger = openLedger({ path: join(ledgerDir, "events.sqlite"), hmacKey: authKey });
  await writeFile(keyFile, authKey, { mode: 0o600 });
  const supervisor = await startSupervisor({ socketPath, authKey, ledger });
  t.after(async () => { await supervisor.close(); ledger.close(); await rm(root, { recursive: true, force: true }); });
  return {
    root, keyFile, socketPath, ledgerDir, ledger,
    env: { AGENT_HARNESS_SOCKET: socketPath, AGENT_HARNESS_KEY_FILE: keyFile },
  };
}

test("Codex hooks persist closed events through the real authenticated supervisor and ledger", async (t) => {
  const { env, ledger, ledgerDir } = await fixture(t);
  const input = payload();
  const { result } = await runHook(t, JSON.stringify(input), env);
  assert.deepEqual(result, silentExit);
  assert.equal(ledger.status().runs, 1, "a supported Codex callback must create its run");
  assert.equal(ledger.status().events, 1, "a supported Codex callback must persist its event");
  const runID = translateCodexHook(input, { authKey }).runID;
  const events = ledger.listEvents(runID);
  assert.equal(events[0].platform, "codex");
  assert.equal(events[0].eventType, "PostToolUse");
  assert.equal(events[0].toolName, "Bash");
  assert.deepEqual(ledger.verifyAll(), { valid: 1, invalid: 0 });
  assert.equal(JSON.stringify(events).includes("private-"), false);
  for (const name of await readdir(ledgerDir)) {
    if (name.startsWith("events.sqlite")) {
      const bytes = await readFile(join(ledgerDir, name));
      for (const sentinel of ["private-session", "private-tool-use", "private-input", "private-response", input.transcript_path]) {
        assert.equal(bytes.includes(Buffer.from(sentinel)), false);
      }
    }
  }
});

test("Codex counts repeated native callbacks separately and correlates pre/post tool phases", async (t) => {
  const { env, ledger } = await fixture(t);
  const inputs = [
    payload({ hook_event_name: "PreToolUse" }),
    payload(),
    payload(),
    payload({ session_id: "other-session" }),
  ];
  for (const input of inputs) {
    assert.deepEqual((await runHook(t, JSON.stringify(input), env)).result, silentExit);
  }
  assert.equal(ledger.status().events, 4);
  assert.equal(ledger.status().runs, 2);
  const events = ledger.listEvents(translateCodexHook(inputs[0], { authKey }).runID);
  assert.deepEqual(events.map((event) => event.eventType), ["PreToolUse", "PostToolUse", "PostToolUse"]);
  assert.equal(new Set(events.map((event) => event.callID)).size, 1);
  assert.equal(new Set(events.map((event) => event.eventID)).size, 3);
  assert.equal(new Set(events.map((event) => event.dedupeKey)).size, 3);
  const other = ledger.listEvents(translateCodexHook(inputs[3], { authKey }).runID)[0];
  assert.notEqual(other.callID, events[0].callID);
  assert.deepEqual(ledger.verifyAll(), { valid: 2, invalid: 0 });
});

test("retrying one immutable Codex event deduplicates through the real ledger", async (t) => {
  const { socketPath, ledger } = await fixture(t);
  const event = translateCodexHook(payload(), {
    authKey, now: new Date("2026-09-19T12:00:00Z"), occurrenceID: "one-callback",
  });
  await request({ socketPath, authKey, method: "ensureRun", params: { runID: event.runID } });
  const first = await request({ socketPath, authKey, method: "append", params: { event } });
  const retry = await request({ socketPath, authKey, method: "append", params: { event } });
  assert.equal(first.inserted, true);
  assert.equal(retry.inserted, false);
  assert.equal(ledger.listEvents(event.runID).length, 1);
  assert.deepEqual(ledger.verifyAll(), { valid: 1, invalid: 0 });
});

test("Codex observes a synthetic credential without emitting hook control output", async (t) => {
  const { env, ledger } = await fixture(t);
  const sentinel = "Authorization: Bearer b7Qx_2mN9-vR4.kL8sP0";
  const input = payload({ tool_response: sentinel, decision: "block", continue: false });
  assert.deepEqual((await runHook(t, JSON.stringify(input), env)).result, silentExit);
  assert.equal(ledger.status().events, 1);
  const events = ledger.listEvents(translateCodexHook(input, { authKey }).runID);
  assert.deepEqual(events[0].decision, {
    schemaVersion: 1, action: "observe", ruleIDs: ["dlp.bearer-token"],
    reason: "Credential-shaped content was observed",
  });
  assert.equal(JSON.stringify(events).includes(sentinel), false);
  assert.equal(Object.hasOwn(events[0], "continue"), false);
});

test("Codex never reads the transcript paths supplied by its host", async (t) => {
  const { root, env, ledger } = await fixture(t);
  const transcript = join(root, "transcript.pipe");
  const createPipe = spawn("mkfifo", [transcript], { stdio: ["ignore", "ignore", "ignore"] });
  assert.deepEqual(await once(createPipe, "close"), [0, null]);
  const input = {
    hook_event_name: "SubagentStop", session_id: "parent", agent_id: "child",
    transcript_path: transcript, agent_transcript_path: transcript,
    last_assistant_message: "finished", stop_hook_active: false,
  };
  const { result } = await runHook(t, JSON.stringify(input), env);
  assert.deepEqual(result, silentExit);
  assert.equal(ledger.status().events, 1, "reading an unopened transcript FIFO would stall before append");
  const event = ledger.listEvents(translateCodexHook(input, { authKey }).runID)[0];
  assert.equal(Object.hasOwn(event, "decision"), false);
  assert.equal(JSON.stringify(event).includes(transcript), false);
});

test("Codex rejects invalid input before creating any ledger run", async (t) => {
  const { env, ledger } = await fixture(t);
  let nested = "leaf";
  for (let index = 0; index < 65; index += 1) nested = { nested };
  const malformedUTF8 = Buffer.concat([
    Buffer.from('{"hook_event_name":"SessionStart","session_id":"'),
    Buffer.from([0xc3, 0x28]),
    Buffer.from('"}'),
  ]);
  for (const input of [
    "{", "null", "[]", "{}",
    JSON.stringify(payload({ hook_event_name: "unknown-private-event" })),
    JSON.stringify(payload({ session_id: null })),
    JSON.stringify(payload({ text: "x".repeat(1024 * 1024) })),
    JSON.stringify(payload({ nested })),
    malformedUTF8,
  ]) {
    assert.deepEqual((await runHook(t, input, env)).result, silentExit);
  }
  assert.deepEqual(ledger.status(), { runs: 0, events: 0, states: {} });
});

test("Codex missing, malformed, permissive and symlinked keys fail silently without ledger writes", async (t) => {
  const { root, keyFile, env, ledger } = await fixture(t);
  const permissive = join(root, "permissive.key");
  const shortKey = join(root, "short.key");
  const wrongKey = join(root, "wrong.key");
  const linkedKey = join(root, "linked.key");
  const linkedParent = join(root, "linked-parent");
  await writeFile(permissive, authKey, { mode: 0o600 });
  await chmod(permissive, 0o644);
  await writeFile(shortKey, Buffer.alloc(31), { mode: 0o600 });
  await writeFile(wrongKey, Buffer.alloc(32, 0x7a), { mode: 0o600 });
  await symlink(keyFile, linkedKey);
  await symlink(root, linkedParent);
  for (const value of [undefined, join(root, "missing.key"), permissive, shortKey, wrongKey, linkedKey, join(linkedParent, "auth.key"), root]) {
    const { result } = await runHook(t, JSON.stringify(payload()), { ...env, AGENT_HARNESS_KEY_FILE: value });
    assert.deepEqual(result, silentExit);
  }
  assert.deepEqual(ledger.status(), { runs: 0, events: 0, states: {} });
});

test("Codex an unavailable or unspecified supervisor fails open", async (t) => {
  const { root, env, ledger } = await fixture(t);
  for (const socketPath of [undefined, join(root, "missing.sock")]) {
    const { result } = await runHook(t, JSON.stringify(payload()), { ...env, AGENT_HARNESS_SOCKET: socketPath });
    assert.deepEqual(result, silentExit);
  }
  assert.equal(ledger.status().runs, 0);
});

test("Codex's total deadline includes an input stream that never closes", async (t) => {
  const { env, ledger } = await fixture(t);
  const { child, done } = launchHook(t, env);
  child.stdin.write('{"hook_event_name":"SessionStart",');
  const { result, elapsedMs } = await done;
  assert.deepEqual(result, silentExit);
  assert.ok(elapsedMs < 1_500, "unfinished stdin must not outlive the one-second deadline plus startup allowance");
  assert.equal(ledger.status().runs, 0);
});

async function socketFixture(t, onRequest) {
  const root = await mkdtemp(join(tmpdir(), "ah-cx-wait-"));
  const keyFile = join(root, "auth.key");
  const socketPath = join(root, "supervisor.sock");
  await writeFile(keyFile, authKey, { mode: 0o600 });
  const sockets = new Set();
  const closed = [];
  const timers = new Set();
  const methods = [];
  const server = net.createServer((socket) => {
    sockets.add(socket);
    closed.push(once(socket, "close"));
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    const decoder = new FrameDecoder();
    socket.on("data", (chunk) => {
      for (const message of decoder.push(chunk)) {
        methods.push(message.method);
        onRequest?.(message, socket, timers);
      }
    });
  });
  await new Promise((resolve, reject) => server.listen(socketPath, resolve).once("error", reject));
  t.after(async () => {
    for (const timer of timers) clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  return { env: { AGENT_HARNESS_SOCKET: socketPath, AGENT_HARNESS_KEY_FILE: keyFile }, sockets, closed, methods };
}

test("Codex times out and closes a supervisor socket that never replies", async (t) => {
  const { env, sockets, closed, methods } = await socketFixture(t);
  const { result, elapsedMs } = await runHook(t, JSON.stringify(payload()), env);
  assert.deepEqual(result, silentExit);
  assert.deepEqual(methods, ["ensureRun"], "the test must actually reach the stalled supervisor");
  assert.ok(elapsedMs < 1_500);
  await Promise.all(closed);
  assert.equal(sockets.size, 0);
});

test("Codex shares one deadline across ensureRun and append instead of waiting a second for each", async (t) => {
  const { env, sockets, closed, methods } = await socketFixture(t, (message, socket, timers) => {
    if (message.method === "ensureRun") {
      timers.add(setTimeout(() => {
        socket.end(encodeFrame(createResponse({
          id: message.id, result: { runID: message.params.runID, state: "CREATED", created: true },
        })));
      }, 700));
    }
    // append intentionally receives no response.
  });
  const { result, elapsedMs } = await runHook(t, JSON.stringify(payload()), env);
  assert.deepEqual(result, silentExit);
  assert.deepEqual(methods, ["ensureRun", "append"]);
  assert.ok(elapsedMs < 1_500, "append must use the deadline remaining after ensureRun");
  await Promise.all(closed);
  assert.equal(sockets.size, 0);
});
