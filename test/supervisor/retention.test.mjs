import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { request } from "../../src/supervisor/client.mjs";
import { startSupervisor } from "../../src/supervisor/server.mjs";
import { createRequest, encodeFrame, FrameDecoder } from "../../src/protocol/rpc.mjs";
import { openLedger } from "../../src/state/ledger.mjs";
import { openDatabase } from "../../src/state/database.mjs";

const key = Buffer.alloc(32, 0xa5);

function framedDigest(values, hmacKey) {
  const hmac = createHmac("sha256", hmacKey);
  for (const value of values) {
    const bytes = Buffer.from(value, "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length);
    hmac.update(length).update(bytes);
  }
  return hmac.digest("hex");
}

function setRunTimestamp(path, runID, lastEventUnix, hmacKey) {
  const activityHMAC = framedDigest(["activity", runID, String(lastEventUnix)], hmacKey);
  const db = openDatabase(path);
  try {
    db.prepare("UPDATE runs SET last_event_unix = ?, activity_hmac = ? WHERE run_id = ?")
      .run(lastEventUnix, activityHMAC, runID);
  } finally {
    db.close();
  }
}

async function fixture(t, ledger = {}, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "ah-retention-rpc-"));
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

// ===== Retention RPC Method Registration Tests =====

test("supervisor dispatches retentionStatus authenticated read RPC to ledger.retentionStatus", async (t) => {
  const calls = [];
  const { socketPath } = await fixture(t, {
    retentionStatus: (...args) => (calls.push(["retentionStatus", ...args]), {
      archivedRuns: 5,
      archivedBytes: 102400,
      policies: { decision: 10, metadata: 20 }
    }),
  });

  const result = await request({ socketPath, authKey: key, method: "retentionStatus", params: {} });
  assert.deepEqual(result, { archivedRuns: 5, archivedBytes: 102400, policies: { decision: 10, metadata: 20 } });
  assert.deepEqual(calls, [["retentionStatus"]]);
});

test("supervisor dispatches prune authenticated mutation RPC to ledger.pruneRuns", async (t) => {
  const calls = [];
  const { socketPath } = await fixture(t, {
    pruneRuns: (...args) => (calls.push(["pruneRuns", ...args]), { archived: ["run-1", "run-2"] }),
  });

  const result = await request({
    socketPath,
    authKey: key,
    method: "prune",
    params: { olderThanUnix: 1700000000, maxRuns: 100, dryRun: false }
  });
  assert.deepEqual(result, { archived: ["run-1", "run-2"] });
  assert.deepEqual(calls, [["pruneRuns", { olderThanUnix: 1700000000, maxRuns: 100, dryRun: false }]]);
});

// ===== Parameter Validation Tests =====

test("prune RPC validates dryRun as strict boolean (not truthy/falsy)", async (t) => {
  const { socketPath } = await fixture(t, {
    pruneRuns() { return { archived: [] }; }
  });

  const cases = [
    { params: { olderThanUnix: 1700000000, maxRuns: 100, dryRun: 1 }, shouldFail: true },
    { params: { olderThanUnix: 1700000000, maxRuns: 100, dryRun: "false" }, shouldFail: true },
    { params: { olderThanUnix: 1700000000, maxRuns: 100, dryRun: null }, shouldFail: true },
    { params: { olderThanUnix: 1700000000, maxRuns: 100, dryRun: true }, shouldFail: false },
    { params: { olderThanUnix: 1700000000, maxRuns: 100, dryRun: false }, shouldFail: false },
  ];

  for (const testCase of cases) {
    const pending = request({
      socketPath,
      authKey: key,
      method: "prune",
      params: testCase.params,
      id: `dryrun-test-${Math.random()}`
    });
    if (testCase.shouldFail) {
      await assert.rejects(pending, { message: "invalid method parameters" }, `dryRun=${JSON.stringify(testCase.params.dryRun)} should fail validation`);
    } else {
      await pending;
    }
  }
});

test("prune RPC validates maxRuns as positive bounded integer (1 to 1000)", async (t) => {
  const { socketPath } = await fixture(t, {
    pruneRuns() { return { archived: [] }; }
  });

  const cases = [
    { params: { olderThanUnix: 1700000000, maxRuns: 0, dryRun: false }, shouldFail: true },
    { params: { olderThanUnix: 1700000000, maxRuns: -1, dryRun: false }, shouldFail: true },
    { params: { olderThanUnix: 1700000000, maxRuns: 1.5, dryRun: false }, shouldFail: true },
    { params: { olderThanUnix: 1700000000, maxRuns: "100", dryRun: false }, shouldFail: true },
    { params: { olderThanUnix: 1700000000, maxRuns: 1001, dryRun: false }, shouldFail: true },
    { params: { olderThanUnix: 1700000000, maxRuns: 1, dryRun: false }, shouldFail: false },
    { params: { olderThanUnix: 1700000000, maxRuns: 100, dryRun: false }, shouldFail: false },
    { params: { olderThanUnix: 1700000000, maxRuns: 1000, dryRun: false }, shouldFail: false },
  ];

  for (const testCase of cases) {
    const pending = request({
      socketPath,
      authKey: key,
      method: "prune",
      params: testCase.params,
      id: `maxruns-test-${Math.random()}`
    });
    if (testCase.shouldFail) {
      await assert.rejects(pending, { message: "invalid method parameters" }, `maxRuns=${testCase.params.maxRuns} should fail validation`);
    } else {
      await pending;
    }
  }
});

test("prune RPC validates olderThanUnix as positive integer (>= 0)", async (t) => {
  const { socketPath } = await fixture(t, {
    pruneRuns() { return { archived: [] }; }
  });

  const cases = [
    { params: { olderThanUnix: -1, maxRuns: 100, dryRun: false }, shouldFail: true },
    { params: { olderThanUnix: 1.5, maxRuns: 100, dryRun: false }, shouldFail: true },
    { params: { olderThanUnix: "1700000000", maxRuns: 100, dryRun: false }, shouldFail: true },
    { params: { olderThanUnix: null, maxRuns: 100, dryRun: false }, shouldFail: true },
    { params: { olderThanUnix: 0, maxRuns: 100, dryRun: false }, shouldFail: false },
    { params: { olderThanUnix: 1700000000, maxRuns: 100, dryRun: false }, shouldFail: false },
  ];

  for (const testCase of cases) {
    const pending = request({
      socketPath,
      authKey: key,
      method: "prune",
      params: testCase.params,
      id: `olderThanUnix-test-${Math.random()}`
    });
    if (testCase.shouldFail) {
      await assert.rejects(pending, { message: "invalid method parameters" }, `olderThanUnix=${JSON.stringify(testCase.params.olderThanUnix)} should fail validation`);
    } else {
      await pending;
    }
  }
});

test("prune RPC requires all three params: olderThanUnix, maxRuns, dryRun", async (t) => {
  const { socketPath } = await fixture(t, {
    pruneRuns() { assert.fail("invalid params were dispatched"); }
  });

  const cases = [
    { params: {}, description: "missing all" },
    { params: { olderThanUnix: 1700000000 }, description: "missing maxRuns and dryRun" },
    { params: { maxRuns: 100 }, description: "missing olderThanUnix and dryRun" },
    { params: { dryRun: false }, description: "missing olderThanUnix and maxRuns" },
    { params: { olderThanUnix: 1700000000, maxRuns: 100 }, description: "missing dryRun" },
    { params: { olderThanUnix: 1700000000, dryRun: false }, description: "missing maxRuns" },
    { params: { maxRuns: 100, dryRun: false }, description: "missing olderThanUnix" },
  ];

  for (const testCase of cases) {
    await assert.rejects(request({
      socketPath,
      authKey: key,
      method: "prune",
      params: testCase.params,
      id: `params-test-${Math.random()}`
    }), { message: "invalid method parameters" }, `prune ${testCase.description} should fail validation`);
  }
});

test("retentionStatus RPC rejects unknown params", async (t) => {
  const { socketPath } = await fixture(t, {
    retentionStatus() { assert.fail("invalid params were dispatched"); }
  });

  await assert.rejects(request({
    socketPath,
    authKey: key,
    method: "retentionStatus",
    params: { extra: true }
  }), { message: "invalid method parameters" });
});

// ===== Idempotency Tests =====

test("prune with dryRun=true is read-like and returns same result on replay", async (t) => {
  let calls = 0;
  const { socketPath } = await fixture(t, {
    pruneRuns(params) {
      calls += 1;
      return { archived: ["run-1", "run-2"] };
    }
  });

  const mutation = createRequest({
    id: "dryrun-replay",
    method: "prune",
    params: { olderThanUnix: 1700000000, maxRuns: 100, dryRun: true },
    authKey: key
  });
  const responses = await rawRequests(socketPath, [mutation, mutation]);

  // Dry-run should not be idempotent-cached (it's read-like, not a true mutation)
  // But calling it twice should still be safe
  assert.deepEqual(responses[0].result, { archived: ["run-1", "run-2"] });
  assert.deepEqual(responses[1].result, { archived: ["run-1", "run-2"] });
});

test("prune with dryRun=false is mutation and replay returns cached response", async (t) => {
  let calls = 0;
  const { socketPath } = await fixture(t, {
    pruneRuns(params) {
      calls += 1;
      return { archived: params.dryRun ? [] : ["run-1"] };
    }
  });

  const mutation = createRequest({
    id: "mutation-replay",
    method: "prune",
    params: { olderThanUnix: 1700000000, maxRuns: 100, dryRun: false },
    authKey: key
  });
  const responses = await rawRequests(socketPath, [mutation, mutation]);

  // Identical authenticated mutations should execute once and cache
  assert.equal(calls, 1, "mutation should execute once");
  assert.deepEqual(responses[0], responses[1], "replay should return cached response");
  assert.deepEqual(responses[0].result, { archived: ["run-1"] });
});

test("retentionStatus is a read RPC and does not cache (executed each time)", async (t) => {
  let calls = 0;
  const { socketPath } = await fixture(t, {
    retentionStatus() {
      calls += 1;
      return { archivedRuns: calls, archivedBytes: calls * 1000, policies: {} };
    }
  });

  const request1 = createRequest({
    id: "status-1",
    method: "retentionStatus",
    params: {},
    authKey: key
  });
  const request2 = createRequest({
    id: "status-2",
    method: "retentionStatus",
    params: {},
    authKey: key
  });
  const responses = await rawRequests(socketPath, [request1, request2]);

  // Read requests should not be cached
  assert.equal(calls, 2, "read RPC should execute twice");
  assert.deepEqual(responses[0].result.archivedRuns, 1);
  assert.deepEqual(responses[1].result.archivedRuns, 2);
});

// ===== Authentication Tests =====

test("retentionStatus requires authentication", async (t) => {
  const { socketPath } = await fixture(t, {
    retentionStatus() { assert.fail("should not be called without auth"); }
  });

  await assert.rejects(
    request({ socketPath, authKey: Buffer.alloc(32, 0x42), method: "retentionStatus", params: {} }),
    /authentication failed/i
  );
});

test("prune requires authentication", async (t) => {
  const { socketPath } = await fixture(t, {
    pruneRuns() { assert.fail("should not be called without auth"); }
  });

  await assert.rejects(
    request({
      socketPath,
      authKey: Buffer.alloc(32, 0x42),
      method: "prune",
      params: { olderThanUnix: 1700000000, maxRuns: 100, dryRun: false }
    }),
    /authentication failed/i
  );
});

// ===== Real Ledger Integration Tests =====

test("supervisor routes retentionStatus to real ledger.retentionStatus", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ah-retention-ledger-"));
  const ledgerPath = join(root, "ledger", "events.sqlite");
  const ledger = openLedger({ path: ledgerPath, hmacKey: key });
  t.after(() => ledger.close());

  const { socketPath } = await fixture(t, ledger);

  // Call retentionStatus on empty ledger
  const result = await request({ socketPath, authKey: key, method: "retentionStatus", params: {} });
  assert.ok(typeof result.archivedRuns === "number");
  assert.ok(typeof result.archivedBytes === "number");
  assert.ok(result.policies);
});

test("supervisor routes prune with dryRun=true to real ledger.pruneRuns", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ah-retention-ledger-2-"));
  const ledgerPath = join(root, "ledger", "events.sqlite");
  const ledger = openLedger({ path: ledgerPath, hmacKey: key });
  t.after(() => ledger.close());

  const { socketPath } = await fixture(t, ledger);

  // Dry-run should not fail and should return an archived list
  const result = await request({
    socketPath,
    authKey: key,
    method: "prune",
    params: { olderThanUnix: 1700000000, maxRuns: 100, dryRun: true }
  });
  assert.ok(Array.isArray(result.archived));
});

test("prune with dryRun=false is single-writer: routed to ledger.pruneRuns mutation", async (t) => {
  const { mkdir } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "ah-retention-writer-"));
  const privateDir = join(root, "ledger");
  await mkdir(privateDir, { recursive: true, mode: 0o700 });
  const ledgerPath = join(privateDir, "events.sqlite");
  const ledger = openLedger({ path: ledgerPath, hmacKey: key });
  t.after(() => ledger.close());

  // Create a test run to prune
  ledger.createRun("run-1");
  ledger.append({
    schemaVersion: 1,
    eventID: "event-1",
    runID: "run-1",
    platform: "opencode",
    sessionHMAC: "a".repeat(64),
    eventType: "PreToolUse",
    timestamp: "2026-08-24T12:34:56.000Z",
    dedupeKey: "run-1:call-1"
  });
  ledger.transitionRun("run-1", "ADMITTED");

  // Age fixture run so it qualifies for pruning (test-only fixture via SQL)
  const nowUnix = Math.floor(Date.now() / 1000);
  const oldUnix = nowUnix - (365 * 86_400);
  setRunTimestamp(ledgerPath, "run-1", oldUnix, key);

  const { socketPath } = await fixture(t, ledger);

  // Prune with cutoff older than the aged run (1 year ago, so use oldUnix to ensure it matches)
  const result = await request({
    socketPath,
    authKey: key,
    method: "prune",
    params: { olderThanUnix: oldUnix, maxRuns: 1000, dryRun: false }
  });
  assert.ok(Array.isArray(result.archived));
  assert.ok(result.archived.includes("run-1"), "prune mutation should archive run-1");
});

// ===== RED TEST: maxRuns unified cap at 1000 via RPC =====

test("RED: prune RPC rejects maxRuns > 1000 to enforce unified cap", async (t) => {
  const { socketPath } = await fixture(t, {
    pruneRuns(params) {
      if (params.maxRuns > 1000) {
        assert.fail("invalid params (maxRuns > 1000) should be rejected before dispatch");
      }
      return { archived: [] };  // Valid requests should return success
    }
  });

  const cases = [
    { maxRuns: 1001, shouldFail: true },
    { maxRuns: 5000, shouldFail: true },
    { maxRuns: 10000, shouldFail: true },
    { maxRuns: 1000, shouldFail: false },
    { maxRuns: 100, shouldFail: false },
  ];

  for (const testCase of cases) {
    const pending = request({
      socketPath,
      authKey: key,
      method: "prune",
      params: { olderThanUnix: 0, maxRuns: testCase.maxRuns, dryRun: false },
      id: `maxruns-cap-${Math.random()}`
    });
    if (testCase.shouldFail) {
      await assert.rejects(pending, { message: "invalid method parameters" },
        `maxRuns=${testCase.maxRuns} should be rejected (unified 1000 cap)`);
    } else {
      await pending;
    }
  }
});

test("RED: prune RPC enforces maxRuns=1000 limit consistently across CLI/RPC/ledger", async (t) => {
  const { socketPath } = await fixture(t, {
    pruneRuns(params) {
      // Verify RPC layer validates before reaching ledger
      assert.ok(params.maxRuns <= 1000, "RPC should enforce maxRuns <= 1000");
      return { archived: [] };
    }
  });

  // Test that RPC correctly rejects >1000
  await assert.rejects(
    request({
      socketPath,
      authKey: key,
      method: "prune",
      params: { olderThanUnix: 0, maxRuns: 1001, dryRun: false }
    }),
    /invalid method parameters/
  );

  // Test that RPC accepts exactly 1000
  const result = await request({
    socketPath,
    authKey: key,
    method: "prune",
    params: { olderThanUnix: 0, maxRuns: 1000, dryRun: false }
  });
  assert.ok(Array.isArray(result.archived));
});
