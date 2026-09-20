import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { request } from "../../src/supervisor/client.mjs";
import { startSupervisor } from "../../src/supervisor/server.mjs";
import { createRequest, createResponse, encodeFrame, FrameDecoder, MAX_FRAME_BYTES } from "../../src/protocol/rpc.mjs";
import { openLedger } from "../../src/state/ledger.mjs";

const key = Buffer.alloc(32, 0x41);

async function fixture(t, ledger = {}, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "ah-rpc-"));
  const socketPath = join(root, "private", "supervisor.sock");
  const server = await startSupervisor({ socketPath, authKey: key, ledger, ...options });
  t.after(() => server.close());
  return { root, socketPath, server };
}

async function connect(socketPath) {
  const socket = net.createConnection(socketPath);
  await new Promise((resolve, reject) => socket.once("connect", resolve).once("error", reject));
  return socket;
}

async function readResponses(socket, count) {
  const decoder = new FrameDecoder();
  const responses = [];
  for await (const chunk of socket) {
    responses.push(...decoder.push(chunk));
    if (responses.length >= count) return responses;
  }
  return responses;
}

async function rawRequests(socketPath, requests) {
  const socket = await connect(socketPath);
  socket.end(Buffer.concat(requests.map(encodeFrame)));
  return readResponses(socket, requests.length);
}

async function waitFor(predicate, timeout = 1_000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail("condition was not met before timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("secures the socket and dispatches every ledger method", async (t) => {
  const calls = [];
  const ledger = {
    ensureRun: (...args) => (calls.push(["ensureRun", ...args]), { runID: args[0], state: "CREATED", created: true }),
    createRun: (...args) => (calls.push(["createRun", ...args]), { runID: args[0], state: "CREATED" }),
    transitionRun: (...args) => (calls.push(["transitionRun", ...args]), { runID: args[0], state: args[1] }),
    append: (...args) => (calls.push(["append", ...args]), { inserted: true }),
    listEvents: (...args) => (calls.push(["listEvents", ...args]), []),
    verifyChain: (...args) => (calls.push(["verifyChain", ...args]), true),
    status: (...args) => (calls.push(["status", ...args]), { runs: 0, events: 0, states: {} }),
    verifyAll: (...args) => (calls.push(["verifyAll", ...args]), { valid: 0, invalid: 0 }),
    metrics: (...args) => (calls.push(["metrics", ...args]), {
      window: { maxEvents: 10_000, eventCount: 0 },
      newestEventTimestamp: null,
      platforms: {},
      eventTypes: {},
      grounding: { injections: 0, matchReasons: {} },
      coalescing: { harnessMetrics: 0 },
      dlp: { observeDecisions: 0 },
    }),
  };
  const { socketPath } = await fixture(t, ledger);
  assert.equal((await lstat(join(socketPath, ".."))).mode & 0o777, 0o700);
  assert.equal((await lstat(socketPath)).mode & 0o777, 0o600);

  assert.deepEqual(await request({ socketPath, authKey: key, method: "health", params: {} }), { ok: true });
  await request({ socketPath, authKey: key, method: "ensureRun", params: { runID: "run-1" } });
  await request({ socketPath, authKey: key, method: "createRun", params: { runID: "run-1" } });
  await request({ socketPath, authKey: key, method: "transitionRun", params: { runID: "run-1", nextState: "ADMITTED" } });
  await request({ socketPath, authKey: key, method: "append", params: { event: { eventID: "event-1" } } });
  await request({ socketPath, authKey: key, method: "listEvents", params: { runID: "run-1" } });
  await request({ socketPath, authKey: key, method: "verifyChain", params: { runID: "run-1" } });
  await request({ socketPath, authKey: key, method: "status", params: {} });
  await request({ socketPath, authKey: key, method: "verifyAll", params: {} });
  await request({ socketPath, authKey: key, method: "metrics", params: {} });
  assert.deepEqual(calls, [
    ["ensureRun", "run-1"], ["createRun", "run-1"], ["transitionRun", "run-1", "ADMITTED"], ["append", { eventID: "event-1" }],
    ["listEvents", "run-1"], ["verifyChain", "run-1"], ["status"], ["verifyAll"], ["metrics", { window: 2_000 }],
  ]);
});

test("supports multiple clients plus fragmented and coalesced frames", async (t) => {
  const { socketPath } = await fixture(t);
  const concurrent = await Promise.all(Array.from({ length: 12 }, () => request({ socketPath, authKey: key, method: "health", params: {} })));
  assert.equal(concurrent.every(({ ok }) => ok), true);

  const socket = net.createConnection(socketPath);
  await new Promise((resolve, reject) => socket.once("connect", resolve).once("error", reject));
  const frames = ["a", "b"].map((id) => encodeFrame(createRequest({ id, method: "health", params: {}, authKey: key })));
  socket.write(frames[0].subarray(0, 3));
  socket.write(Buffer.concat([frames[0].subarray(3), frames[1]]));
  const decoder = new FrameDecoder();
  const responses = [];
  for await (const chunk of socket) {
    responses.push(...decoder.push(chunk));
    if (responses.length === 2) break;
  }
  socket.destroy();
  assert.deepEqual(responses.map(({ id, result }) => ({ id, result })), [
    { id: "a", result: { ok: true } }, { id: "b", result: { ok: true } },
  ]);
});

test("rejects bad authentication and generic errors do not echo secrets", async (t) => {
  const secret = "TOP-SECRET-VALUE";
  const { socketPath } = await fixture(t, { createRun() { throw new Error(`failed ${secret}`); } });
  await assert.rejects(request({ socketPath, authKey: Buffer.alloc(32, 0x42), method: "health", params: {} }), /authentication failed/i);
  await assert.rejects(request({ socketPath, authKey: key, method: "createRun", params: { runID: secret } }), (error) => {
    assert.match(error.message, /request failed/i);
    assert.equal(error.message.includes(secret), false);
    return true;
  });
});

test("rejects symlinked socket components and existing socket symlinks", async () => {
  const root = await mkdir(join(tmpdir(), `compass-rpc-link-${process.pid}-${Date.now()}`), { recursive: true });
  const target = join(root, "target");
  await mkdir(target, { mode: 0o700 });
  await symlink(target, join(root, "linked"), "dir");
  await assert.rejects(startSupervisor({ socketPath: join(root, "linked", "server.sock"), authKey: key, ledger: {} }), /symlink/i);

  const socketPath = join(target, "server.sock");
  await writeFile(join(root, "ordinary"), "x");
  await symlink(join(root, "ordinary"), socketPath, "file");
  await assert.rejects(startSupervisor({ socketPath, authKey: key, ledger: {} }), /symlink/i);
});

test("refuses a permissive existing socket parent", async () => {
  const root = await mkdir(join(tmpdir(), `compass-rpc-mode-${process.pid}-${Date.now()}`), { recursive: true });
  const parent = join(root, "private");
  await mkdir(parent, { mode: 0o700 });
  await chmod(parent, 0o755);
  await assert.rejects(startSupervisor({ socketPath: join(parent, "server.sock"), authKey: key, ledger: {} }), /0700|mode|permission/i);
});

test("graceful close removes only its owned socket and zeros its key copy", async (t) => {
  const inputKey = Buffer.from(key);
  const { socketPath, server } = await fixture(t);
  await server.close();
  await assert.rejects(lstat(socketPath), { code: "ENOENT" });
  assert.deepEqual(inputKey, key);
  assert.equal(server.authKeyCleared, true);
});

test("client times out", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ah-to-"));
  const socketPath = join(root, "stalled.sock");
  const stalled = net.createServer(() => {});
  await new Promise((resolve, reject) => stalled.listen(socketPath, resolve).once("error", reject));
  t.after(() => stalled.close());
  await assert.rejects(request({ socketPath, authKey: key, method: "health", params: {}, timeout: 20 }), /timed out/i);
});

test("identical authenticated mutation replay executes once and returns the cached response", async (t) => {
  let calls = 0;
  const { socketPath } = await fixture(t, {
    createRun(runID) { calls += 1; return { runID, sequence: calls }; },
  });
  const replay = createRequest({ id: "replay-1", method: "createRun", params: { runID: "run-1" }, authKey: key });
  const responses = await rawRequests(socketPath, [replay, replay]);
  assert.equal(calls, 1);
  assert.deepEqual(responses[0], responses[1]);
});

test("same request ID with different authenticated content is rejected", async (t) => {
  let calls = 0;
  const { socketPath } = await fixture(t, {
    createRun(runID) { calls += 1; return { runID }; },
  });
  const responses = await rawRequests(socketPath, [
    createRequest({ id: "collision-1", method: "createRun", params: { runID: "run-1" }, authKey: key }),
    createRequest({ id: "collision-1", method: "createRun", params: { runID: "run-2" }, authKey: key }),
  ]);
  assert.equal(calls, 1);
  assert.equal(responses[1].error?.code, "INVALID_ARGUMENT");
});

test("identical concurrent mutations on different sockets dispatch exactly once", async (t) => {
  let calls = 0;
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const { socketPath } = await fixture(t, {
    async createRun(runID) {
      calls += 1;
      await blocked;
      return { runID };
    },
  });
  const mutation = createRequest({ id: "concurrent-replay", method: "createRun", params: { runID: "run-1" }, authKey: key });
  const first = rawRequests(socketPath, [mutation]);
  const second = rawRequests(socketPath, [mutation]);
  await waitFor(() => calls > 0);
  await new Promise((resolve) => setTimeout(resolve, 25));
  release();

  const responses = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.deepEqual(responses[0][0], responses[1][0]);
});

test("same request ID with different content conflicts while the first mutation is in flight", async (t) => {
  let calls = 0;
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const { socketPath } = await fixture(t, {
    async createRun(runID) {
      calls += 1;
      if (runID === "run-1") await blocked;
      return { runID };
    },
  });
  const first = rawRequests(socketPath, [
    createRequest({ id: "in-flight-conflict", method: "createRun", params: { runID: "run-1" }, authKey: key }),
  ]);
  await waitFor(() => calls === 1);
  const conflicting = await rawRequests(socketPath, [
    createRequest({ id: "in-flight-conflict", method: "createRun", params: { runID: "run-2" }, authKey: key }),
  ]);
  release();
  await first;

  assert.equal(calls, 1);
  assert.equal(conflicting[0].error?.code, "INVALID_ARGUMENT");
});

test("health and read requests cannot evict a completed mutation replay", async (t) => {
  let calls = 0;
  const { socketPath } = await fixture(t, {
    createRun(runID) { calls += 1; return { runID }; },
    listEvents() { return []; },
    verifyChain() { return true; },
  });
  const mutation = createRequest({ id: "protected-mutation", method: "createRun", params: { runID: "run-1" }, authKey: key });
  await rawRequests(socketPath, [mutation]);

  for (let index = 0; index < 1_025; index += 1) {
    const method = index % 3 === 0 ? "health" : index % 3 === 1 ? "listEvents" : "verifyChain";
    const params = method === "health" ? {} : { runID: "run-1" };
    await rawRequests(socketPath, [createRequest({ id: `read-${index}`, method, params, authKey: key })]);
  }
  await rawRequests(socketPath, [mutation]);

  assert.equal(calls, 1);
});

test("mutation replay capacity evicts cached responses without rejecting writes or defeating ledger dedupe", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ah-rpc-capacity-"));
  const ledger = openLedger({ path: join(root, "ledger", "events.sqlite"), hmacKey: key });
  t.after(() => ledger.close());
  const { socketPath } = await fixture(t, ledger, { maxMutationReplayEntries: 2 });
  const events = Array.from({ length: 3 }, (_, index) => ({
    schemaVersion: 1,
    eventID: `event-${index}`,
    runID: `run-${index}`,
    platform: "claude",
    sessionHMAC: String(index + 1).repeat(64),
    eventType: "PostToolUse",
    timestamp: "2026-08-24T12:34:56.000Z",
    dedupeKey: `dedupe-${index}`,
  }));

  for (const [index, event] of events.entries()) {
    const ensured = await request({ socketPath, authKey: key, method: "ensureRun", params: { runID: event.runID }, id: `ensure-${index}` });
    assert.equal(ensured.runID, event.runID);
    const appended = await request({ socketPath, authKey: key, method: "append", params: { event }, id: `append-${index}` });
    assert.equal(appended.inserted, true);
  }

  const replayed = await request({ socketPath, authKey: key, method: "append", params: { event: events[0] }, id: "append-old-retry" });
  assert.equal(replayed.inserted, false);
  assert.equal(ledger.listEvents(events[0].runID).length, 1);
});

test("a second supervisor cannot replace a live socket and the first remains reachable", async (t) => {
  const { socketPath } = await fixture(t);
  const outcome = await startSupervisor({ socketPath, authKey: key, ledger: {} }).then(
    (server) => ({ server }),
    (error) => ({ error }),
  );
  if (outcome.server) {
    await outcome.server.close();
    assert.fail("second supervisor replaced the live socket");
  }
  assert.match(outcome.error.message, /already|active|in use|EADDRINUSE/i);
  assert.deepEqual(await request({ socketPath, authKey: key, method: "health", params: {} }), { ok: true });
});

test("closes an incomplete frame after the configured idle timeout", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ah-idle-"));
  const socketPath = join(root, "private", "supervisor.sock");
  const server = await startSupervisor({ socketPath, authKey: key, ledger: {}, idleTimeout: 30 });
  t.after(() => server.close());
  const socket = await connect(socketPath);
  socket.write(Buffer.from([0, 0, 0, 10, 0x7b]));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("incomplete frame connection remained open")), 500);
    socket.once("close", () => { clearTimeout(timer); resolve(); });
    socket.once("error", reject);
  });
});

test("rejects connections beyond the configured maximum", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ah-limit-"));
  const socketPath = join(root, "private", "supervisor.sock");
  const server = await startSupervisor({ socketPath, authKey: key, ledger: {}, maxConnections: 1 });
  t.after(() => server.close());
  const first = await connect(socketPath);
  t.after(() => first.destroy());
  const second = await connect(socketPath);
  t.after(() => second.destroy());
  const closed = new Promise((resolve) => second.once("close", resolve));
  await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error("excess connection remained open")), 500))]);
  assert.equal(first.destroyed, false);
  first.write(encodeFrame(createRequest({ id: "admitted", method: "health", params: {}, authKey: key })));
  const [response] = await readResponses(first, 1);
  assert.deepEqual(response.result, { ok: true });
});

test("waits for socket drain before dispatching a subsequent queued request", async (t) => {
  const calls = [];
  const { socketPath } = await fixture(t, {
    append(event) {
      calls.push(event.eventID);
      return event.eventID === "first" ? { payload: "x".repeat(900 * 1024) } : { ok: true };
    },
  });
  const socket = await connect(socketPath);
  t.after(() => socket.destroy());
  socket.write(Buffer.concat([
    encodeFrame(createRequest({ id: "bp-1", method: "append", params: { event: { eventID: "first" } }, authKey: key })),
    encodeFrame(createRequest({ id: "bp-2", method: "append", params: { event: { eventID: "second" } }, authKey: key })),
  ]));
  await waitFor(() => calls.length > 0);
  assert.deepEqual(calls, ["first"]);
  const responses = await readResponses(socket, 2);
  assert.equal(responses.length, 2);
  assert.deepEqual(calls, ["first", "second"]);
});

test("pauses socket input before dispatching a decoded batch and resumes only after response drain", async (t) => {
  const lifecycle = [];
  const originalPause = net.Socket.prototype.pause;
  const originalResume = net.Socket.prototype.resume;
  const originalWrite = net.Socket.prototype.write;
  let serverSocket;
  let forceBackpressure = true;
  net.Socket.prototype.pause = function (...args) {
    if (this.server) {
      serverSocket = this;
      lifecycle.push("pause");
    }
    return originalPause.apply(this, args);
  };
  net.Socket.prototype.resume = function (...args) {
    if (this === serverSocket) lifecycle.push("resume");
    return originalResume.apply(this, args);
  };
  net.Socket.prototype.write = function (...args) {
    const accepted = Boolean(this.server);
    if (accepted) serverSocket = this;
    const result = originalWrite.apply(this, args);
    if (accepted && forceBackpressure) {
      forceBackpressure = false;
      lifecycle.push("write-blocked");
      return false;
    }
    return result;
  };
  t.after(() => {
    net.Socket.prototype.pause = originalPause;
    net.Socket.prototype.resume = originalResume;
    net.Socket.prototype.write = originalWrite;
  });

  const calls = [];
  const { socketPath } = await fixture(t, {
    append(event) {
      calls.push(event.eventID);
      lifecycle.push(`dispatch-${event.eventID}`);
      return { ok: true };
    },
  });
  const socket = await connect(socketPath);
  t.after(() => socket.destroy());
  socket.write(Buffer.concat([
    encodeFrame(createRequest({ id: "bounded-1", method: "append", params: { event: { eventID: "first" } }, authKey: key })),
    encodeFrame(createRequest({ id: "bounded-2", method: "append", params: { event: { eventID: "second" } }, authKey: key })),
  ]));

  await waitFor(() => lifecycle.includes("write-blocked"));
  assert.deepEqual(calls, ["first"]);
  assert.equal(serverSocket.isPaused(), true);
  assert.ok(lifecycle.indexOf("pause") < lifecycle.indexOf("dispatch-first"));

  serverSocket.emit("drain");
  const responses = await readResponses(socket, 2);
  assert.equal(responses.length, 2);
  assert.deepEqual(calls, ["first", "second"]);
  assert.ok(lifecycle.indexOf("write-blocked") < lifecycle.indexOf("resume"));
  assert.ok(lifecycle.indexOf("resume") <= lifecycle.indexOf("dispatch-second"));
});

test("listEvents returns bounded offset pages with default and maximum limits", async (t) => {
  const events = Array.from({ length: 650 }, (_, index) => ({
    eventID: `event-${index}`,
    payload: "x".repeat(2 * 1024),
  }));
  const calls = [];
  const { socketPath } = await fixture(t, {
    listEvents(runID) {
      calls.push(runID);
      return events;
    },
  });

  const first = await request({ socketPath, authKey: key, method: "listEvents", params: { runID: "large-run" } });
  assert.deepEqual(first.events, events.slice(0, 100));
  assert.equal(first.nextCursor, 100);

  const capped = await request({
    socketPath,
    authKey: key,
    method: "listEvents",
    params: { runID: "large-run", cursor: first.nextCursor, limit: 500 },
  });
  assert.deepEqual(capped.events, events.slice(100, 600));
  assert.equal(capped.nextCursor, 600);

  const last = await request({
    socketPath,
    authKey: key,
    method: "listEvents",
    params: { runID: "large-run", cursor: capped.nextCursor, limit: 500 },
  });
  assert.deepEqual(last, { events: events.slice(600), nextCursor: null });
  assert.deepEqual(calls, ["large-run", "large-run", "large-run"]);
});

test("listEvents constrains each page to the serialized response byte budget", async (t) => {
  const events = Array.from({ length: 12 }, (_, index) => ({ eventID: `large-${index}`, payload: "x".repeat(96 * 1024) }));
  const { socketPath } = await fixture(t, { listEvents() { return events; } });
  const collected = [];
  let cursor = 0;
  do {
    const page = await request({ socketPath, authKey: key, method: "listEvents", params: { runID: "large-run", cursor, limit: 500 } });
    assert.ok(page.events.length > 0 && page.events.length < 500);
    assert.ok(encodeFrame(createResponse({ id: "budget-check", result: page })).length <= 768 * 1024);
    collected.push(...page.events);
    cursor = page.nextCursor;
  } while (cursor !== null);
  assert.deepEqual(collected, events);
  assert.ok(Buffer.byteLength(JSON.stringify(events)) > MAX_FRAME_BYTES);
});

test("retries an idempotent append after an oversized response", async (t) => {
  let calls = 0;
  const { socketPath } = await fixture(t, {
    append() {
      calls += 1;
      return calls === 1 ? { payload: "x".repeat(MAX_FRAME_BYTES) } : { inserted: true };
    },
  });
  const oversized = createRequest({ id: "oversized-retry", method: "append", params: { event: { eventID: "event-1" } }, authKey: key });
  const responses = await rawRequests(socketPath, [oversized, oversized]);
  assert.equal(calls, 2);
  assert.equal(responses.length, 2);
  assert.deepEqual(responses[0].error, { code: "RESOURCE_EXHAUSTED", message: "response exceeds frame limit" });
  assert.deepEqual(responses[1].result, { inserted: true });
  assert.ok(responses.every((response) => encodeFrame(response).length <= MAX_FRAME_BYTES + 4));
});

test("retries an idempotent ensureRun after a transient failure", async (t) => {
  let calls = 0;
  const { socketPath } = await fixture(t, {
    ensureRun(runID) {
      calls += 1;
      if (calls === 1) throw new Error("transient");
      return { runID, state: "CREATED", created: true };
    },
  });
  const retry = createRequest({ id: "failed-retry", method: "ensureRun", params: { runID: "run-1" }, authKey: key });
  const responses = await rawRequests(socketPath, [retry, retry]);

  assert.equal(calls, 2);
  assert.deepEqual(responses[0].error, { code: "FAILED", message: "request failed" });
  assert.deepEqual(responses[1].result, { runID: "run-1", state: "CREATED", created: true });
});

test("every RPC method rejects missing and unknown params with INVALID_ARGUMENT", async (t) => {
  const { socketPath } = await fixture(t, {
    createRun() { assert.fail("invalid params were dispatched"); },
    ensureRun() { assert.fail("invalid params were dispatched"); },
    transitionRun() { assert.fail("invalid params were dispatched"); },
    append() { assert.fail("invalid params were dispatched"); },
    listEvents() { assert.fail("invalid params were dispatched"); },
    verifyChain() { assert.fail("invalid params were dispatched"); },
  });
  const cases = [
    ["health", [{ extra: true }]],
    ["ensureRun", [{}, { runID: "run-1", extra: true }]],
    ["createRun", [{}, { runID: "run-1", extra: true }]],
    ["transitionRun", [{ runID: "run-1" }, { runID: "run-1", nextState: "ADMITTED", extra: true }]],
    ["append", [{}, { event: { eventID: "event-1" }, extra: true }]],
    ["listEvents", [
      {},
      { runID: "run-1", extra: true },
      { runID: "run-1", cursor: -1 },
      { runID: "run-1", cursor: 1.5 },
      { runID: "run-1", cursor: "0" },
      { runID: "run-1", limit: 0 },
      { runID: "run-1", limit: 501 },
      { runID: "run-1", limit: 1.5 },
      { runID: "run-1", limit: "100" },
    ]],
    ["verifyChain", [{}, { runID: "run-1", extra: true }]],
    ["status", [{ extra: true }]],
    ["verifyAll", [{ extra: true }]],
  ];
  const requests = cases.flatMap(([method, variants], index) => variants.map((params, variant) =>
    createRequest({ id: `invalid-${index}-${variant}`, method, params, authKey: key })));
  const responses = await rawRequests(socketPath, requests);
  assert.equal(responses.length, requests.length);
  assert.deepEqual(responses.map(({ error }) => error?.code), requests.map(() => "INVALID_ARGUMENT"));
});

test("status and verifyAll require authentication even with empty params", async (t) => {
  let calls = 0;
  const { socketPath } = await fixture(t, {
    status() { calls += 1; return { runs: 0, events: 0, states: {} }; },
    verifyAll() { calls += 1; return { valid: 0, invalid: 0 }; },
  });

  for (const method of ["status", "verifyAll"]) {
    await assert.rejects(
      request({ socketPath, authKey: Buffer.alloc(32, 0x42), method, params: {} }),
      /authentication failed/i,
    );
  }
  assert.equal(calls, 0);
});
