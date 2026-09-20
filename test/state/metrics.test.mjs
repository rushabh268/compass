import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openDatabase } from "../../src/state/database.mjs";
import { openLedger } from "../../src/state/ledger.mjs";

const key = Buffer.alloc(32, 0xa5);
const sentinel = "METRICS-RAW-SENTINEL-DO-NOT-LEAK";

function summary() {
  return {
    coalesced: 0,
    messagePartDelta: 0,
    messagePartUpdate: 0,
    messageUpdate: 0,
    sessionStatus: 0,
    sessionDiff: 0,
    todoUpdate: 0,
    noise: 0,
    queueFull: 0,
  };
}

function event(runID, index, overrides = {}) {
  return {
    schemaVersion: 1,
    eventID: `${runID}-event-${index}`,
    runID,
    platform: "opencode",
    sessionHMAC: "3".repeat(64),
    eventType: "PreToolUse",
    timestamp: "2026-08-24T12:34:56.000Z",
    dedupeKey: `${runID}:call-${index}`,
    ...overrides,
  };
}

async function fixture(t, prefix = "ah-metrics-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const ledger = openLedger({ path: join(root, "private", "ledger.sqlite"), hmacKey: key });
  t.after(() => ledger.close());
  return { ledger, root };
}

function deleteEventRows(root, ids) {
  const db = openDatabase(join(root, "private", "ledger.sqlite"));
  try {
    for (const id of ids) db.prepare("DELETE FROM events WHERE id = ?").run(id);
  } finally {
    db.close();
  }
}

function appendMix(ledger, runID = "metrics-run") {
  ledger.createRun(runID);
  const events = [
    event(runID, 1, {
      platform: "claude",
      decision: { schemaVersion: 1, action: "observe", ruleIDs: ["rule.observe.1"], reason: "observe decision" },
    }),
    event(runID, 2, {
      eventType: "GroundingInjection",
      metadata: { sources: [], matchReason: "ticket" },
    }),
    event(runID, 3, {
      platform: "claude",
      eventType: "GroundingInjection",
      metadata: { sources: [], matchReason: "branch-folder-overlap" },
    }),
    event(runID, 4, {
      eventType: "HarnessMetrics",
      summary: summary(),
    }),
    event(runID, 5, {
      platform: "claude",
      eventType: "GroundingInjection",
      metadata: { sources: [], matchReason: "none" },
    }),
    event(runID, 6, {
      platform: "claude",
      eventType: "PostToolUse",
      decision: { schemaVersion: 1, action: "observe", ruleIDs: ["rule.observe.2"], reason: "second observe" },
    }),
  ];
  for (const value of events) ledger.append(value);
}

test("metrics returns exact metadata aggregates for the bounded event window", async (t) => {
  const { ledger } = await fixture(t);
  appendMix(ledger);

  const metrics = ledger.metrics();

  assert.deepEqual(metrics.window, { maxEvents: 10_000, eventCount: 6 });
  assert.deepEqual(metrics.platforms, { claude: 4, opencode: 2 });
  assert.deepEqual(metrics.eventTypes, {
    PreToolUse: 1,
    GroundingInjection: 3,
    HarnessMetrics: 1,
    PostToolUse: 1,
  });
  assert.equal(metrics.grounding.injections, 3);
  assert.deepEqual(metrics.grounding.matchReasons, {
    ticket: 1,
    "branch-folder-overlap": 1,
    none: 1,
  });
  assert.equal(metrics.coalescing.harnessMetrics, 1);
  assert.equal(metrics.dlp.observeDecisions, 2);
});

test("metrics names canonical event types and buckets opaque labels under other", async (t) => {
  const { ledger } = await fixture(t);
  const runID = "event-type-bucket-run";
  ledger.createRun(runID);
  for (const value of [
    event(runID, 1, { eventType: "GroundingInjection", metadata: { sources: [], matchReason: "none" } }),
    event(runID, 2, { eventType: "HarnessMetrics", summary: summary() }),
    event(runID, 3, { eventType: "PreToolUse" }),
    event(runID, 4, { eventType: "a".repeat(64) }),
    event(runID, 5, { eventType: "b".repeat(64) }),
  ]) ledger.append(value);

  const metrics = ledger.metrics();

  assert.deepEqual(metrics.eventTypes, {
    GroundingInjection: 1,
    HarnessMetrics: 1,
    PreToolUse: 1,
    other: 2,
  });
  assert.equal(/[0-9a-f]{64}/i.test(JSON.stringify(metrics)), false);
});

test("metrics excludes missing grounding match reasons instead of creating a null key", async (t) => {
  const { ledger } = await fixture(t);
  const runID = "missing-match-reason-run";
  ledger.createRun(runID);
  ledger.append(event(runID, 1, { eventType: "GroundingInjection" }));

  const metrics = ledger.metrics();

  assert.equal(metrics.grounding.injections, 1);
  assert.deepEqual(metrics.grounding.matchReasons, {});
  assert.equal(Object.hasOwn(metrics.grounding.matchReasons, "null"), false);
});

test("metrics window contains only the last events by SQLite id", async (t) => {
  const { ledger } = await fixture(t);
  const runID = "window-run";
  ledger.createRun(runID);
  ledger.append(event(runID, 1, {
    platform: "claude",
    eventType: "GroundingInjection",
    metadata: { sources: [], matchReason: "ticket" },
  }));
  ledger.append(event(runID, 2, { platform: "claude", eventType: "PreToolUse" }));
  ledger.append(event(runID, 3, { platform: "opencode", eventType: "HarnessMetrics", summary: summary() }));
  ledger.append(event(runID, 4, { platform: "opencode", eventType: "PostToolUse" }));
  ledger.append(event(runID, 5, { platform: "claude", eventType: "PreToolUse" }));

  const metrics = ledger.metrics({ window: 3 });

  assert.equal(metrics.window.maxEvents, 3);
  assert.equal(metrics.window.eventCount, 3);
  assert.deepEqual(metrics.platforms, { claude: 1, opencode: 2 });
  assert.deepEqual(metrics.eventTypes, { HarnessMetrics: 1, PostToolUse: 1, PreToolUse: 1 });
  assert.equal(metrics.grounding.injections, 0);
  assert.equal(Object.hasOwn(metrics.grounding.matchReasons, "ticket"), false);
});

test("metrics window selects the last surviving rows rather than an id range", async (t) => {
  const { ledger, root } = await fixture(t);
  const runID = "gapped-window-run";
  ledger.createRun(runID);
  ledger.append(event(runID, 1, { eventType: "PreToolUse" }));
  ledger.append(event(runID, 2, { eventType: "PostToolUse" }));
  ledger.append(event(runID, 3, { eventType: "HarnessMetrics", summary: summary() }));
  ledger.append(event(runID, 4, { eventType: "PostToolUseFailure" }));
  ledger.append(event(runID, 5, { eventType: "PreToolUse" }));
  ledger.append(event(runID, 6, {
    eventType: "GroundingInjection",
    metadata: { sources: [], matchReason: "none" },
  }));
  deleteEventRows(root, [4]);

  const metrics = ledger.metrics({ window: 3 });

  assert.equal(metrics.window.eventCount, 3);
  assert.deepEqual(metrics.eventTypes, {
    GroundingInjection: 1,
    HarnessMetrics: 1,
    PreToolUse: 1,
  });
  assert.equal(metrics.newestEventTimestamp, "2026-08-24T12:34:56.000Z");
});

test("newestEventTimestamp follows event id order rather than timestamp ordering", async (t) => {
  const { ledger } = await fixture(t);
  const runID = "timestamp-order-run";
  ledger.createRun(runID);
  ledger.append(event(runID, 1, { timestamp: "2099-12-31T23:59:59.000Z" }));
  ledger.append(event(runID, 2, { timestamp: "2000-01-01T00:00:00.000Z" }));

  assert.equal(ledger.metrics().newestEventTimestamp, "2000-01-01T00:00:00.000Z");
});

test("empty metrics are zeroed, deeply frozen, and JSON round-trip safely", async (t) => {
  const { ledger } = await fixture(t);

  const metrics = ledger.metrics();

  assert.deepEqual(metrics, {
    window: { maxEvents: 10_000, eventCount: 0 },
    newestEventTimestamp: null,
    platforms: {},
    eventTypes: {},
    grounding: { injections: 0, matchReasons: {} },
    coalescing: { harnessMetrics: 0 },
    dlp: { observeDecisions: 0 },
  });
  assert.equal(Object.isFrozen(metrics), true);
  assert.equal(Object.isFrozen(metrics.window), true);
  assert.equal(Object.isFrozen(metrics.platforms), true);
  assert.equal(Object.isFrozen(metrics.eventTypes), true);
  assert.equal(Object.isFrozen(metrics.grounding), true);
  assert.equal(Object.isFrozen(metrics.grounding.matchReasons), true);
  assert.equal(Object.isFrozen(metrics.coalescing), true);
  assert.equal(Object.isFrozen(metrics.dlp), true);
  assert.throws(() => { metrics.window.eventCount = 1; }, TypeError);
  assert.throws(() => { metrics.grounding.matchReasons.ticket = 1; }, TypeError);
  assert.deepEqual(JSON.parse(JSON.stringify(metrics)), metrics);
});

test("metrics never returns raw event privacy fields or planted body text", async (t) => {
  const { ledger } = await fixture(t);
  const runID = "privacy-run-id";
  ledger.createRun(runID);
  const receipt = ledger.append(event(runID, 1, {
    eventID: "privacy-event-id",
    dedupeKey: "privacy-dedupe-key",
    sessionHMAC: "b".repeat(64),
    eventType: "GroundingInjection",
    metadata: { sources: [{ kind: "repo-comment", ref: `/private/${sentinel}` }], matchReason: "none" },
  }));

  const serialized = JSON.stringify(ledger.metrics());
  for (const forbidden of [
    sentinel,
    runID,
    "privacy-event-id",
    "privacy-dedupe-key",
    "b".repeat(64),
    receipt.hmac,
    ...(receipt.previousHMAC ? [receipt.previousHMAC] : []),
  ]) {
    assert.equal(serialized.includes(forbidden), false, `metrics leaked ${forbidden}`);
  }
  assert.deepEqual(Object.keys(JSON.parse(serialized)).sort(), [
    "coalescing", "dlp", "eventTypes", "grounding", "newestEventTimestamp", "platforms", "window",
  ]);
});

test("metrics rejects windows outside the safe 1..10,000 range", async (t) => {
  const { ledger } = await fixture(t);

  for (const window of [0, -1, 10_001, 1.5, Number.NaN]) {
    assert.throws(() => ledger.metrics({ window }), /window/i, `window=${window} should be rejected`);
  }
});
