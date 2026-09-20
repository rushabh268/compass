import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { request } from "../../src/supervisor/client.mjs";
import { startSupervisor } from "../../src/supervisor/server.mjs";
import { openLedger } from "../../src/state/ledger.mjs";

const key = Buffer.alloc(32, 0x41);
const badKey = Buffer.alloc(32, 0x42);
const sentinel = "SUPERVISOR-METRICS-RAW-SENTINEL";

function event(runID, index, overrides = {}) {
  return {
    schemaVersion: 1,
    eventID: `${runID}-event-${index}`,
    runID,
    platform: "opencode",
    sessionHMAC: "3".repeat(64),
    eventType: "GroundingInjection",
    timestamp: "2026-08-24T12:34:56.000Z",
    dedupeKey: `${runID}:call-${index}`,
    metadata: { sources: [{ kind: "repo-comment", ref: `/private/${sentinel}` }], matchReason: "none" },
    ...overrides,
  };
}

async function supervisorFixture(t, ledger, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "ah-metrics-rpc-"));
  const socketPath = join(root, "private", "supervisor.sock");
  const server = await startSupervisor({ socketPath, authKey: key, ledger, ...options });
  t.after(() => server.close());
  return { root, socketPath, server };
}

async function realLedger(t, prefix = "ah-metrics-ledger-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const ledger = openLedger({ path: join(root, "private", "events.sqlite"), hmacKey: key });
  t.after(() => ledger.close());
  return ledger;
}

function assertMetadataOnly(result) {
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(sentinel), false);
  for (const keyPart of ["runID", "eventID", "sessionHMAC", "hmac", "raw", "observe decision", "rule.observe"]) {
    assert.equal(serialized.includes(keyPart), false, `metrics response leaked ${keyPart}`);
  }
  assert.deepEqual(Object.keys(result).sort(), [
    "coalescing", "dlp", "eventTypes", "grounding", "newestEventTimestamp", "platforms", "window",
  ]);
}

test("metrics is an authenticated read RPC with closed empty params", async (t) => {
  const expected = {
    window: { maxEvents: 10_000, eventCount: 0 },
    newestEventTimestamp: null,
    platforms: {},
    eventTypes: {},
    grounding: { injections: 0, matchReasons: {} },
    coalescing: { harnessMetrics: 0 },
    dlp: { observeDecisions: 0 },
  };
  let calls = 0;
  const { socketPath } = await supervisorFixture(t, {
    metrics() {
      calls += 1;
      return expected;
    },
  });

  assert.deepEqual(await request({ socketPath, authKey: key, method: "metrics", params: {} }), expected);
  await assert.rejects(
    request({ socketPath, authKey: badKey, method: "metrics", params: {} }),
    /authentication failed/i,
  );
  await assert.rejects(
    request({ socketPath, authKey: key, method: "metrics", params: { extra: true } }),
    /invalid method parameters/i,
  );
  assert.equal(calls, 1, "invalid and unauthenticated metrics requests must not dispatch");
});

test("metrics uses a TTL cache independent of request ids and returns metadata only", async (t) => {
  const ledger = await realLedger(t);
  const runID = "supervisor-cache-run";
  ledger.createRun(runID);
  ledger.append(event(runID, 1));
  let calls = 0;
  const wrappedLedger = {
    metrics(...args) {
      calls += 1;
      return ledger.metrics(...args);
    },
  };
  let now = 10_000;
  const { socketPath } = await supervisorFixture(t, wrappedLedger, {
    metricsCacheTTL: 1_000,
    now: () => now,
  });

  const first = await request({ socketPath, authKey: key, method: "metrics", params: {}, id: "metrics-cache-1" });
  const second = await request({ socketPath, authKey: key, method: "metrics", params: {}, id: "metrics-cache-2" });
  now += 999;
  const third = await request({ socketPath, authKey: key, method: "metrics", params: {}, id: "metrics-cache-3" });

  assert.equal(calls, 1, "distinct request ids must share the metrics TTL cache");
  assert.deepEqual(second, first);
  assert.deepEqual(third, first);
  assertMetadataOnly(first);

  now += 2;
  const afterTTL = await request({ socketPath, authKey: key, method: "metrics", params: {}, id: "metrics-cache-4" });
  assert.equal(calls, 2, "metrics must recompute after the TTL expires");
  assert.deepEqual(afterTTL, first);
  assertMetadataOnly(afterTTL);
});

test("metrics calls with distinct ids do not populate the completed read-replay cache", async (t) => {
  let calls = 0;
  let clock = 0;
  const { socketPath } = await supervisorFixture(t, {
    metrics() {
      calls += 1;
      return { sequence: calls };
    },
  }, {
    metricsCacheTTL: 1_000,
    now: () => (clock += 1_001),
  });

  const firstID = "metrics-no-replay-0";
  for (let index = 0; index < 64; index += 1) {
    const id = index === 0 ? firstID : `metrics-no-replay-${index}`;
    assert.deepEqual(
      await request({ socketPath, authKey: key, method: "metrics", params: {}, id }),
      { sequence: index + 1 },
    );
  }

  const afterDistinctIDs = await request({
    socketPath,
    authKey: key,
    method: "metrics",
    params: {},
    id: firstID,
  });
  assert.equal(calls, 65, "metrics must execute again instead of replaying a retained response");
  assert.deepEqual(afterDistinctIDs, { sequence: 65 });
});
