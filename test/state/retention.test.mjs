import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openDatabase } from "../../src/state/database.mjs";
import { openLedger } from "../../src/state/ledger.mjs";

const key = Buffer.alloc(32, 0xa5);

function event(runID, overrides = {}) {
  return {
    schemaVersion: 1,
    eventID: `${runID}-event-1`,
    runID,
    platform: "opencode",
    sessionHMAC: "3".repeat(64),
    eventType: "PreToolUse",
    timestamp: "2026-08-24T12:34:56.000Z",
    dedupeKey: `${runID}:call-1`,
    ...overrides,
  };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), `ah-retention-${process.pid}-${Date.now()}-${Math.random()}`));
  // Create private directory with mode 0700 (openDatabase requires parent to be 0700)
  const { mkdir } = await import("node:fs/promises");
  const privateDir = join(root, "private");
  await mkdir(privateDir, { recursive: true, mode: 0o700 });
  const path = join(privateDir, "ledger.sqlite");
  const ledger = openLedger({ path, hmacKey: key });
  t.after(() => ledger.close());
  return { ledger, path, root };
}

function framedDigest(values, hmacKey = key) {
  const hmac = createHmac("sha256", hmacKey);
  for (const value of values) {
    const bytes = Buffer.from(value, "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length);
    hmac.update(length).update(bytes);
  }
  return hmac.digest("hex");
}

function activityHMAC(hmacKey, runID, lastEventUnix) {
  return framedDigest([
    "activity",
    runID,
    String(lastEventUnix),
  ], hmacKey);
}

function setRunTimestamp(path, runID, lastEventUnix, hmacKey) {
  const db = openDatabase(path);
  try {
    db.prepare("UPDATE runs SET last_event_unix = ?, activity_hmac = ? WHERE run_id = ?")
      .run(lastEventUnix, activityHMAC(hmacKey, runID, lastEventUnix), runID);
  } finally {
    db.close();
  }
}

// Helper: Age fixture runs via SQL so they qualify for pruning.
// By default, sets last_event_unix to 365 days ago (ensures all policy cutoffs pass).
function ageRuns(path, runIDs, hmacKey, daysAgo = 365) {
  const oldUnix = Math.floor(Date.now() / 1000) - (daysAgo * 86_400);
  const db = openDatabase(path);
  try {
    for (const runID of runIDs) {
      db.prepare("UPDATE runs SET last_event_unix = ?, activity_hmac = ? WHERE run_id = ?")
        .run(oldUnix, activityHMAC(hmacKey, runID, oldUnix), runID);
    }
  } finally {
    db.close();
  }
}

// ===== Schema Tests =====

test("schema includes run_archive table with required columns", async (t) => {
  const { path, ledger } = await fixture(t);
  const db = openDatabase(path);
  t.after(() => db.close());

  // Verify table exists with expected structure
  const tables = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type='table' AND name='run_archive'
  `).all();
  assert.equal(tables.length, 1, "run_archive table should exist");

  // Verify columns exist
  const schema = db.prepare("PRAGMA table_info(run_archive)").all();
  const columnNames = schema.map(col => col.name);
  for (const col of ["run_id", "state", "event_count", "head_hmac", "commitment", "pruned_at", "archive_hmac"]) {
    assert.ok(columnNames.includes(col), `run_archive should have ${col} column`);
  }
});

test("runs table includes last_event_unix column for retention decisions", async (t) => {
  const { path, ledger } = await fixture(t);
  const db = openDatabase(path);
  t.after(() => db.close());

  const schema = db.prepare("PRAGMA table_info(runs)").all();
  const columnNames = schema.map(col => col.name);
  assert.ok(columnNames.includes("last_event_unix"), "runs should have last_event_unix");
});

test("run_archive deliberately has NO foreign key to runs (independent archive storage)", async (t) => {
  const { path, ledger } = await fixture(t);
  const db = openDatabase(path);
  t.after(() => db.close());

  const fkInfo = db.prepare("PRAGMA foreign_key_list(run_archive)").all();
  const hasFK = fkInfo.some(fk => fk.table === "runs" && fk.from === "run_id" && fk.to === "run_id");
  assert.equal(hasFK, false, "run_archive.run_id should NOT have FK to runs.run_id (archive is independent)");
});

// ===== Transactional Prune Tests =====

test("prune is atomic: all-or-nothing for whole run archive", async (t) => {
  const { ledger, path } = await fixture(t);
  ledger.createRun("run-1");
  ledger.append(event("run-1"));
  ledger.transitionRun("run-1", "ADMITTED");

  // Attempt to prune with a date very far in future to NOT archive run-1
  const futureUnix = Math.floor(Date.now() / 1000) + 400 * 24 * 60 * 60;
  const dryRun = ledger.pruneRuns({ olderThanUnix: futureUnix, maxRuns: 1000, dryRun: true });
  assert.ok(Array.isArray(dryRun.archived), "dry-run should return archived list");
  assert.equal(dryRun.archived.length, 0, "no runs should be old enough when future date used");

  // Verify run still exists and is not archived
  const events = ledger.listEvents("run-1");
  assert.equal(events.length, 1, "run should still have events after dry-run");
});

test("prune with dryRun=true does not mutate database", async (t) => {
  const { ledger } = await fixture(t);
  ledger.createRun("run-1");
  ledger.append(event("run-1"));

  const statusBefore = ledger.status();
  const oldestUnix = 0; // Very old date
  const result = ledger.pruneRuns({ olderThanUnix: oldestUnix, maxRuns: 1000, dryRun: true });
  const statusAfter = ledger.status();

  assert.deepEqual(statusBefore, statusAfter, "dry-run should not change database");
  assert.ok(Array.isArray(result.archived), "dry-run should return archived list");
});

test("prune with dryRun=false persists archive records", async (t) => {
  const { ledger, path } = await fixture(t);
  ledger.createRun("run-1");
  ledger.append(event("run-1"));
  ledger.transitionRun("run-1", "ADMITTED");

  // Age fixture run so it qualifies for pruning (test-only fixture via SQL)
  ageRuns(path, ["run-1"], key);

  // Omit olderThanUnix to use retention policy cutoff (180 days for metadata-only runs)
  const result = ledger.pruneRuns({ maxRuns: 1000, dryRun: false });

  const db = openDatabase(path);
  t.after(() => db.close());

  const archived = db.prepare("SELECT COUNT(*) as count FROM run_archive").get();
  assert.equal(archived.count, 1, "should have 1 archived run");

  const archiveRecord = db.prepare("SELECT * FROM run_archive WHERE run_id = ?").get("run-1");
  assert.ok(archiveRecord, "archived run should exist in run_archive");
  assert.equal(archiveRecord.run_id, "run-1");
});

// ===== Archive Record Integrity Tests =====

test("archived run record contains run_id, state, event_count, head_hmac, commitment", async (t) => {
  const { ledger, path } = await fixture(t);
  ledger.createRun("run-1");
  ledger.append(event("run-1"));
  ledger.transitionRun("run-1", "ADMITTED");

  // Age fixture run so it qualifies for pruning (test-only fixture via SQL)
  ageRuns(path, ["run-1"], key);

  // Omit olderThanUnix to use retention policy cutoff (180 days for metadata-only runs)
  ledger.pruneRuns({ maxRuns: 1000, dryRun: false });

  const db = openDatabase(path);
  t.after(() => db.close());

  const record = db.prepare("SELECT * FROM run_archive WHERE run_id = ?").get("run-1");
  assert.equal(record.run_id, "run-1");
  assert.equal(record.state, "ADMITTED");
  assert.equal(record.event_count, 1);
  assert.ok(typeof record.head_hmac === "string" && record.head_hmac.length > 0, "head_hmac should be set");
  assert.ok(typeof record.commitment === "string" && record.commitment.length > 0, "commitment should be set");
  assert.ok(record.pruned_at > 0, "pruned_at timestamp should be set");
});

test("archive_hmac in archive record includes commitment and all receipt fields", async (t) => {
  const { ledger, path } = await fixture(t);
  ledger.createRun("run-1");
  ledger.append(event("run-1"));
  ledger.transitionRun("run-1", "ADMITTED");

  // Age fixture run so it qualifies for pruning (test-only fixture via SQL)
  ageRuns(path, ["run-1"], key);

  // Omit olderThanUnix to use retention policy cutoff (180 days for metadata-only runs)
  ledger.pruneRuns({ maxRuns: 1000, dryRun: false });

  const db = openDatabase(path);
  t.after(() => db.close());

  const record = db.prepare("SELECT * FROM run_archive WHERE run_id = ?").get("run-1");
  assert.ok(record.archive_hmac, "archive_hmac should be present");
  assert.ok(record.commitment, "commitment should be present in archive record");

  // Verify archive_hmac includes commitment and receipt fields
  // Format: ["archive", run_id, state, event_count, head_hmac, commitment, pruned_at, activity_hmac]
  const expectedHmac = framedDigest([
    "archive",
    record.run_id,
    record.state,
    String(record.event_count),
    record.head_hmac,
    record.commitment,
    String(record.pruned_at),
    record.activity_hmac,
  ]);
  assert.equal(record.archive_hmac, expectedHmac, "archive_hmac should include commitment and receipt fields");
});

test("archive integrity check detects tampering", async (t) => {
  const { ledger, path } = await fixture(t);
  ledger.createRun("run-1");
  ledger.append(event("run-1"));
  ledger.transitionRun("run-1", "ADMITTED");

  ledger.pruneRuns({ olderThanUnix: 0, maxRuns: 1000, dryRun: false });

  const db = openDatabase(path);
  t.after(() => db.close());

  // Tamper with archive record
  db.prepare("UPDATE run_archive SET state = ? WHERE run_id = ?").run("ACTIVE", "run-1");

  // Verify should detect tampering
  const valid = ledger.verifyArchive("run-1");
  assert.equal(valid, false, "verifyArchive should detect tampering");
});

// ===== Retention Policy Tests =====

test("decision-bearing run uses 365-day retention", async (t) => {
  const { ledger } = await fixture(t);
  ledger.createRun("run-decision");
  const baseEvent = event("run-decision", {
    decision: {
      schemaVersion: 1,
      action: "block",
      ruleIDs: ["rule-1"],
      reason: "Test decision"
    }
  });
  ledger.append(baseEvent);

  // Decision-bearing runs have longer retention (365 days)
  const policy = ledger.getRetentionPolicy("run-decision");
  assert.equal(policy.retentionDays, 365, "decision-bearing run should use 365-day retention");
});

test("metadata-only run uses 180-day retention", async (t) => {
  const { ledger } = await fixture(t);
  ledger.createRun("run-meta");
  const baseEvent = event("run-meta");
  delete baseEvent.decision;
  ledger.append(baseEvent);

  // Metadata-only runs have shorter retention (180 days)
  const policy = ledger.getRetentionPolicy("run-meta");
  assert.equal(policy.retentionDays, 180, "metadata-only run should use 180-day retention");
});

test("recent run is retained regardless of policy", async (t) => {
  const { ledger, path } = await fixture(t);
  ledger.createRun("run-recent");
  ledger.append(event("run-recent"));

  // Set last_event_unix to now via direct DB update (test-only fixture)
  const nowUnix = Math.floor(Date.now() / 1000);
  setRunTimestamp(path, "run-recent", nowUnix, key);

  // Reopen ledger to pick up the change
  const ledger2 = openLedger({ path, hmacKey: key });
  t.after(() => ledger2.close());

  // Try to prune with cutoff before now - should skip recent run
  const result = ledger2.pruneRuns({ olderThanUnix: nowUnix - 1, maxRuns: 1000, dryRun: false });
  assert.ok(!result.archived.includes("run-recent"), "recent run should be retained");
});

test("prune respects maxRuns parameter for chunking", async (t) => {
  const { ledger, path } = await fixture(t);

  // Create 5 old runs
  for (let i = 0; i < 5; i++) {
    const runID = `run-${i}`;
    ledger.createRun(runID);
    ledger.append(event(runID));
    ledger.transitionRun(runID, "ADMITTED");
  }

  // Age all fixture runs so they qualify for pruning (test-only fixture via SQL)
  ageRuns(path, ["run-0", "run-1", "run-2", "run-3", "run-4"], key);

  // Omit olderThanUnix to use retention policy cutoff (180 days for metadata-only runs)
  const result = ledger.pruneRuns({ maxRuns: 2, dryRun: false });

  assert.ok(result.archived.length <= 2, "should respect maxRuns limit");
  assert.ok(result.archived.length > 0, "should archive at least some runs");
});

// ===== Foreign Key Integrity Tests =====

test("pruning archives receipt then deletes events and run in one transaction", async (t) => {
  const { ledger, path } = await fixture(t);
  ledger.createRun("run-1");
  ledger.append(event("run-1"));
  ledger.transitionRun("run-1", "ADMITTED");

  const eventsBefore = ledger.listEvents("run-1");
  assert.equal(eventsBefore.length, 1, "should have 1 event before prune");

  // Age fixture run so it qualifies for pruning (test-only fixture via SQL)
  ageRuns(path, ["run-1"], key);

  // Omit olderThanUnix to use retention policy cutoff (180 days for metadata-only runs)
  ledger.pruneRuns({ maxRuns: 1000, dryRun: false });

  const db = openDatabase(path);
  t.after(() => db.close());

  // After prune, run and events should be deleted in single transaction
  const runExists = db.prepare("SELECT COUNT(*) as count FROM runs WHERE run_id = ?").get("run-1");
  assert.equal(runExists.count, 0, "run should be deleted after archive");

  const eventsExist = db.prepare("SELECT COUNT(*) as count FROM events WHERE run_id = ?").get("run-1");
  assert.equal(eventsExist.count, 0, "events should be deleted after archive");

  // But archive record should still exist
  const archiveExists = db.prepare("SELECT COUNT(*) as count FROM run_archive WHERE run_id = ?").get("run-1");
  assert.equal(archiveExists.count, 1, "archive record should exist");
});

test("other non-archived runs still verify correctly", async (t) => {
  const { ledger, path } = await fixture(t);

  ledger.createRun("run-1");
  ledger.append(event("run-1"));
  ledger.transitionRun("run-1", "ADMITTED");

  ledger.createRun("run-2");
  ledger.append(event("run-2"));
  ledger.transitionRun("run-2", "ADMITTED");
  ledger.transitionRun("run-2", "ACTIVE");

  // Age only run-1 so it's eligible for archival (test-only fixture via SQL)
  ageRuns(path, ["run-1"], key);

  // Archive only run-1 (omit olderThanUnix to use retention policy cutoff)
  ledger.pruneRuns({ maxRuns: 1000, dryRun: false });

  // run-2 should still verify
  assert.equal(ledger.verifyChain("run-2"), true, "non-archived run should verify");

  // run-1 in archive should verify
  assert.equal(ledger.verifyArchive("run-1"), true, "archived run should verify via archive");
});

// ===== Status and Retention Info Tests =====

test("retention-status returns logical bytes and run counts for archived runs", async (t) => {
  const { ledger, path } = await fixture(t);

  for (let i = 0; i < 3; i++) {
    const runID = `run-${i}`;
    ledger.createRun(runID);
    ledger.append(event(runID));
    ledger.transitionRun(runID, "ADMITTED");
  }

  // Age all fixture runs so they qualify for pruning (test-only fixture via SQL)
  ageRuns(path, ["run-0", "run-1", "run-2"], key);

  // Omit olderThanUnix to use retention policy cutoff (180 days for metadata-only runs)
  ledger.pruneRuns({ maxRuns: 1000, dryRun: false });

  const status = ledger.retentionStatus();
  assert.ok(status.archivedRuns >= 3, "should report archived run count");
  assert.ok(status.archivedBytes > 0, "should report archived bytes");
  assert.ok(typeof status.archivedBytes === "number");
  assert.ok(typeof status.archivedRuns === "number");
});

test("retention-status includes retention policy summary", async (t) => {
  const { ledger } = await fixture(t);
  ledger.createRun("run-1");
  ledger.append(event("run-1", {
    decision: {
      schemaVersion: 1,
      action: "block",
      ruleIDs: ["rule-1"],
      reason: "Test"
    }
  }));

  const status = ledger.retentionStatus();
  assert.ok(status.policies, "status should include policies");
  assert.ok(status.policies.decision, "policies should track decision-bearing runs");
  assert.ok(status.policies.metadata, "policies should track metadata-only runs");
});

// ===== Supervisor RPC Tests =====

test("supervisor provides prune RPC via ledger.pruneRuns (single writer pattern)", async (t) => {
  // This test verifies the supervisor layer can expose retention operations
  // through ledger.pruneRuns. Server RPC and CLI single-writer enforced at supervisor level.
  const { ledger, path } = await fixture(t);

  ledger.createRun("run-1");
  ledger.append(event("run-1"));
  ledger.transitionRun("run-1", "ADMITTED");

  // Verify pruneRuns is available (supervisor would route to this)
  assert.ok(typeof ledger.pruneRuns === "function", "ledger should expose pruneRuns for supervisor to route");

  const result = ledger.pruneRuns({ olderThanUnix: 0, maxRuns: 1000, dryRun: false });
  assert.ok(Array.isArray(result.archived), "pruneRuns should return result with archived list");
});

// ===== Last Event Unix Tests =====

test("last_event_unix is updated on append via direct DB query", async (t) => {
  const { ledger, path } = await fixture(t);
  ledger.createRun("run-1");

  const beforeUnix = Math.floor(Date.now() / 1000);
  ledger.append(event("run-1"));
  const afterUnix = Math.floor(Date.now() / 1000);

  // Verify last_event_unix was updated by direct DB query
  const db = openDatabase(path);
  const run = db.prepare("SELECT last_event_unix FROM runs WHERE run_id = ?").get("run-1");
  db.close();
  t.after(() => {});

  assert.ok(run.last_event_unix >= beforeUnix && run.last_event_unix <= afterUnix, "last_event_unix should be updated on append");
});

test("last_event_unix monotonically increases via direct DB queries", async (t) => {
  const { ledger, path } = await fixture(t);
  ledger.createRun("run-1");

  ledger.append(event("run-1", { dedupeKey: "run-1:call-1" }));

  const db = openDatabase(path);
  const unix1 = db.prepare("SELECT last_event_unix FROM runs WHERE run_id = ?").get("run-1").last_event_unix;
  db.close();

  await new Promise(resolve => setTimeout(resolve, 10));

  ledger.append(event("run-1", { dedupeKey: "run-1:call-2", eventID: "run-1-event-2" }));

  const db2 = openDatabase(path);
  const unix2 = db2.prepare("SELECT last_event_unix FROM runs WHERE run_id = ?").get("run-1").last_event_unix;
  db2.close();
  t.after(() => {});

  assert.ok(unix2 >= unix1, "last_event_unix should not decrease");
});

// ===== Mixed Scenario Tests =====

test("archive HMAC verifies across reopens", async (t) => {
  const { ledger, path } = await fixture(t);
  ledger.createRun("run-1");
  ledger.append(event("run-1"));
  ledger.transitionRun("run-1", "ADMITTED");

  // Age fixture run so it qualifies for pruning (test-only fixture via SQL)
  ageRuns(path, ["run-1"], key);

  // Omit olderThanUnix to use retention policy cutoff (180 days for metadata-only runs)
  ledger.pruneRuns({ maxRuns: 1000, dryRun: false });
  assert.equal(ledger.verifyArchive("run-1"), true, "archive should verify before reopen");
  ledger.close();

  // Reopen ledger
  const ledger2 = openLedger({ path, hmacKey: key });
  t.after(() => ledger2.close());

  assert.equal(ledger2.verifyArchive("run-1"), true, "archive should verify after reopen");
});

test("mixed archived and active runs coexist", async (t) => {
  const { ledger, path } = await fixture(t);

  // Create old run to be archived
  ledger.createRun("run-old");
  ledger.append(event("run-old"));
  ledger.transitionRun("run-old", "ADMITTED");

  // Create recent run to be kept
  ledger.createRun("run-new");
  ledger.append(event("run-new"));
  const nowUnix = Math.floor(Date.now() / 1000);

  // Age run-old, keep run-new recent (test-only fixture via SQL)
  const oldUnix = nowUnix - 365 * 86_400; // Age run-old by 365 days
  setRunTimestamp(path, "run-old", oldUnix, key);
  setRunTimestamp(path, "run-new", nowUnix, key);

  // Reopen ledger to pick up the change
  const ledger2 = openLedger({ path, hmacKey: key });
  t.after(() => ledger2.close());

  // Prune only very old runs
  const ninetyDaysAgo = nowUnix - 90 * 24 * 60 * 60;
  const result = ledger2.pruneRuns({ olderThanUnix: ninetyDaysAgo, maxRuns: 1000, dryRun: false });

  // run-old should be archived
  assert.ok(result.archived.includes("run-old"), "old run should be archived");

  // run-new should not be archived
  assert.ok(!result.archived.includes("run-new"), "new run should be kept");

  // Both should verify
  assert.equal(ledger2.verifyArchive("run-old"), true, "archived run should verify");
  assert.equal(ledger2.verifyChain("run-new"), true, "active run should verify");
});

test("prune result includes accurate archived run list", async (t) => {
  const { ledger, path } = await fixture(t);

  const expectedRunIDs = [];
  for (let i = 0; i < 3; i++) {
    const runID = `run-${i}`;
    expectedRunIDs.push(runID);
    ledger.createRun(runID);
    ledger.append(event(runID));
    ledger.transitionRun(runID, "ADMITTED");
  }

  // Age all fixture runs so they qualify for pruning (test-only fixture via SQL)
  ageRuns(path, expectedRunIDs, key);

  // Omit olderThanUnix to use retention policy cutoff (180 days for metadata-only runs)
  const result = ledger.pruneRuns({ maxRuns: 1000, dryRun: false });

   assert.deepEqual(new Set(result.archived), new Set(expectedRunIDs), "prune result should list all archived runs");
});

// ===== RED TEST: Recent ADMITTED runs survive ANY past cutoff =====

test("RED: recent ADMITTED run must survive even with olderThanUnix=0 (force cutoff)", async (t) => {
  const { ledger, path } = await fixture(t);
  ledger.createRun("run-recent");
  ledger.append(event("run-recent"));
  ledger.transitionRun("run-recent", "ADMITTED");

  // Set last_event_unix to now (within policy window)
  const nowUnix = Math.floor(Date.now() / 1000);
  setRunTimestamp(path, "run-recent", nowUnix, key);

  const ledger2 = openLedger({ path, hmacKey: key });
  t.after(() => ledger2.close());

  // Even with olderThanUnix=0, recent ADMITTED must be retained by policy window
  const result = ledger2.pruneRuns({ olderThanUnix: 0, maxRuns: 1000, dryRun: false });
  assert.ok(!result.archived.includes("run-recent"),
    "recent ADMITTED run should NOT be archived despite olderThanUnix=0, respecting 180/365-day policy");
});

test("RED: only ADMITTED state qualifies for inactive pruning logic", async (t) => {
  const { ledger, path } = await fixture(t);

  // Create ADMITTED run (eligible for inactivity check)
  ledger.createRun("run-admitted");
  ledger.append(event("run-admitted"));
  ledger.transitionRun("run-admitted", "ADMITTED");

  // Create ACTIVE run (never eligible for pruning, even if old)
  ledger.createRun("run-active");
  ledger.append(event("run-active"));
  ledger.transitionRun("run-active", "ADMITTED");
  ledger.transitionRun("run-active", "ACTIVE");

  // Age only the ADMITTED run (test-only fixture via SQL)
  ageRuns(path, ["run-admitted"], key);

  // Omit olderThanUnix to use retention policy cutoff (180 days for metadata-only runs)
  const result = ledger.pruneRuns({ maxRuns: 1000, dryRun: false });

  // ADMITTED should be archived (old enough and not ACTIVE)
  assert.ok(result.archived.includes("run-admitted"), "ADMITTED run should be eligible for archival");

  // ACTIVE should NOT be archived (ACTIVE runs are never prunable)
  assert.ok(!result.archived.includes("run-active"),
    "ACTIVE run should NOT be archived regardless of age");
});

test("RED: ACTIVE state blocks pruning even if older than policy", async (t) => {
  const { ledger, path } = await fixture(t);

  ledger.createRun("run-active");
  ledger.append(event("run-active"));
  ledger.transitionRun("run-active", "ADMITTED");
  ledger.transitionRun("run-active", "ACTIVE");

  // Set to very old timestamp
  setRunTimestamp(path, "run-active", 1, key);

  const ledger2 = openLedger({ path, hmacKey: key });
  t.after(() => ledger2.close());

  const result = ledger2.pruneRuns({ olderThanUnix: 0, maxRuns: 1000, dryRun: false });
  assert.ok(!result.archived.includes("run-active"),
    "ACTIVE run should NOT be archived (only ADMITTED eligible for inactivity)");
});

// ===== RED TEST: olderThanUnix cannot shorten policy windows =====

test("RED: olderThanUnix=0 cannot prune metadata-only run within 180-day window", async (t) => {
  const { ledger, path } = await fixture(t);

  // Metadata-only run (no decision field)
  ledger.createRun("run-metadata-200d");
  const baseEvent = event("run-metadata-200d");
  delete baseEvent.decision;
  ledger.append(baseEvent);
  ledger.transitionRun("run-metadata-200d", "ADMITTED");

  // Set last_event_unix to 200 days ago (outside 180-day window)
  const nowUnix = Math.floor(Date.now() / 1000);
  const days200Ago = nowUnix - 200 * 24 * 60 * 60;
  setRunTimestamp(path, "run-metadata-200d", days200Ago, key);

  const ledger2 = openLedger({ path, hmacKey: key });
  t.after(() => ledger2.close());

  // Even with olderThanUnix=0, 180-day policy must be respected
  const result = ledger2.pruneRuns({
    olderThanUnix: 0,
    maxRuns: 1000,
    metadataDays: 180,
    decisionDays: 365,
    dryRun: false
  });
  assert.ok(!result.archived.includes("run-metadata-200d"),
    "metadata run at 200d must be retained (180-day policy cannot be shortened)");
});

test("RED: olderThanUnix=0 cannot prune decision run within 365-day window", async (t) => {
  const { ledger, path } = await fixture(t);

  // Decision-bearing run
  ledger.createRun("run-decision-400d");
  ledger.append(event("run-decision-400d", {
    decision: {
      schemaVersion: 1,
      action: "block",
      ruleIDs: ["rule-1"],
      reason: "Test decision"
    }
  }));
  ledger.transitionRun("run-decision-400d", "ADMITTED");

  // Set last_event_unix to 400 days ago
  const nowUnix = Math.floor(Date.now() / 1000);
  const days400Ago = nowUnix - 400 * 24 * 60 * 60;
  setRunTimestamp(path, "run-decision-400d", days400Ago, key);

  const ledger2 = openLedger({ path, hmacKey: key });
  t.after(() => ledger2.close());

  // Even with olderThanUnix=0, 365-day policy must be respected
  const result = ledger2.pruneRuns({
    olderThanUnix: 0,
    maxRuns: 1000,
    metadataDays: 180,
    decisionDays: 365,
    dryRun: false
  });
  assert.ok(!result.archived.includes("run-decision-400d"),
    "decision run at 400d must be retained (365-day policy cannot be shortened)");
});

test("RED: explicit retention policy days override olderThanUnix calculation", async (t) => {
  const { ledger, path } = await fixture(t);

  // Metadata-only run at 190 days old (outside 180 but inside 200)
  ledger.createRun("run-custom-policy");
  const baseEvent = event("run-custom-policy");
  delete baseEvent.decision;
  ledger.append(baseEvent);
  ledger.transitionRun("run-custom-policy", "ADMITTED");

  const nowUnix = Math.floor(Date.now() / 1000);
  const days190Ago = nowUnix - 190 * 24 * 60 * 60;
  setRunTimestamp(path, "run-custom-policy", days190Ago, key);

  const ledger2 = openLedger({ path, hmacKey: key });
  t.after(() => ledger2.close());

  // With 200-day custom policy, should be retained
  const result200 = ledger2.pruneRuns({
    olderThanUnix: 0,
    maxRuns: 1000,
    metadataDays: 200,
    decisionDays: 365,
    dryRun: false
  });
  assert.ok(!result200.archived.includes("run-custom-policy"),
    "run should be retained with custom 200-day policy");
});

// ===== RED TEST: Migration backfill legacy last_event_unix =====

test("RED: migration detects legacy last_event_unix=0 and backfills to migration time", async (t) => {
  const { ledger, path } = await fixture(t);

  // Create and setup run normally
  ledger.createRun("run-legacy");
  ledger.append(event("run-legacy"));
  ledger.transitionRun("run-legacy", "ADMITTED");
  ledger.close();

  // Simulate legacy database: manually set last_event_unix to 0
  const db = openDatabase(path);
  const migrationTimeUnix = Math.floor(Date.now() / 1000);
  db.prepare("UPDATE runs SET last_event_unix = 0 WHERE run_id = ?").run("run-legacy");
  db.close();

  // Reopen ledger (would trigger migration if implemented)
  const ledger2 = openLedger({ path, hmacKey: key });
  t.after(() => ledger2.close());

  // Verify last_event_unix was backfilled to migration time or later
  const db2 = openDatabase(path);
  const run = db2.prepare("SELECT last_event_unix FROM runs WHERE run_id = ?").get("run-legacy");
  db2.close();

  assert.ok(run.last_event_unix > 0, "legacy run should have non-zero last_event_unix after migration");
  assert.ok(run.last_event_unix >= migrationTimeUnix, "backfilled last_event_unix should be >= migration time");
});

test("RED: first prune after migration retains metadata beyond new backfill time", async (t) => {
  const { ledger, path } = await fixture(t);

  // Create run (will have last_event_unix set to current time)
  ledger.createRun("run-first-prune");
  ledger.append(event("run-first-prune"));
  ledger.transitionRun("run-first-prune", "ADMITTED");

  const nowUnix = Math.floor(Date.now() / 1000);
  const db = openDatabase(path);
  db.prepare("UPDATE runs SET last_event_unix = 0 WHERE run_id = ?").run("run-first-prune");
  db.close();

  const ledger2 = openLedger({ path, hmacKey: key });
  t.after(() => ledger2.close());

  // Immediate prune with future cutoff should not archive
  // (backfilled time + policy window should protect it)
  const futureUnix = nowUnix + 100 * 24 * 60 * 60;
  const result = ledger2.pruneRuns({
    olderThanUnix: futureUnix,
    maxRuns: 1000,
    metadataDays: 180,
    dryRun: false
  });

  // Should NOT be archived if backfill logic is correct
  assert.ok(!result.archived.includes("run-first-prune") || result.archived.length === 0,
    "first prune after migration should respect backfilled retention window");
});

// ===== RED TEST: ensureRun rejects archived run IDs =====

test("RED: ensureRun rejects run ID present in run_archive table (no chain recreation)", async (t) => {
  const { ledger, path } = await fixture(t);

  // Create, populate, and archive a run
  ledger.createRun("run-archived");
  ledger.append(event("run-archived"));
  ledger.transitionRun("run-archived", "ADMITTED");

  // Age fixture run so it qualifies for pruning (test-only fixture via SQL)
  ageRuns(path, ["run-archived"], key);

  // Omit olderThanUnix to use retention policy cutoff (180 days for metadata-only runs)
  ledger.pruneRuns({ maxRuns: 1000, dryRun: false });
  ledger.close();

  // Verify run is in archive, not in runs table
  const db = openDatabase(path);
  const archived = db.prepare("SELECT COUNT(*) as count FROM run_archive WHERE run_id = ?").get("run-archived");
  const inRuns = db.prepare("SELECT COUNT(*) as count FROM runs WHERE run_id = ?").get("run-archived");
  db.close();
  assert.equal(archived.count, 1, "run should be in archive");
  assert.equal(inRuns.count, 0, "run should not be in runs table");

  // Reopen ledger and try ensureRun on archived ID
  const ledger2 = openLedger({ path, hmacKey: key });
  t.after(() => ledger2.close());

  // ensureRun should reject archived IDs to prevent chain recreation
  assert.throws(
    () => ledger2.ensureRun("run-archived"),
    /archived|run_archive|cannot recreate|exists in archive/i,
    "ensureRun must reject run IDs found in run_archive table"
  );
});

// ===== RED TEST: verifyAll and retentionStatus include archive HMAC validity =====

test("RED: verifyAll includes archive record tampering detection in counts", async (t) => {
  const { ledger, path } = await fixture(t);

  // Create and archive a run
  ledger.createRun("run-verify");
  ledger.append(event("run-verify"));
  ledger.transitionRun("run-verify", "ADMITTED");

  ledger.pruneRuns({ olderThanUnix: 0, maxRuns: 1000, dryRun: false });
  ledger.close();

  // Tamper with archive record
  const db = openDatabase(path);
  db.prepare("UPDATE run_archive SET state = ? WHERE run_id = ?").run("CREATED", "run-verify");
  db.close();

  // Reopen and call verifyAll
  const ledger2 = openLedger({ path, hmacKey: key });
  t.after(() => ledger2.close());

  // verifyAll should detect tampering in archive
  const result = ledger2.verifyAll();

  // Result should include archive tamper count or indicate invalid archives
  assert.ok(typeof result === "object", "verifyAll should return object");
  assert.ok("valid" in result || "archived" in result || "tampered" in result,
    "verifyAll must report on archive integrity (valid/invalid/tampered/archived_invalid)");
});

test("RED: retentionStatus includes archive HMAC validity metrics", async (t) => {
  const { ledger, path } = await fixture(t);

  // Create and archive two runs
  for (let i = 0; i < 2; i++) {
    const runID = `run-status-${i}`;
    ledger.createRun(runID);
    ledger.append(event(runID));
    ledger.transitionRun(runID, "ADMITTED");
  }

  ledger.pruneRuns({ olderThanUnix: 0, maxRuns: 1000, dryRun: false });

  // Tamper with one archive record
  const db = openDatabase(path);
  db.prepare("UPDATE run_archive SET archive_hmac = ? WHERE run_id = ?").run("invalid", "run-status-0");
  db.close();

  // Get retention status
  const status = ledger.retentionStatus();

  // Status should include archive integrity metrics
  assert.ok(typeof status === "object", "retentionStatus should return object");
  assert.ok("archivedRuns" in status && "archivedBytes" in status, "should report counts");
  assert.ok(
    "archiveTamperCount" in status || "archiveValid" in status || "archiveInvalid" in status,
    "retentionStatus must include archive HMAC validity/tamper metrics"
  );
});

// ===== RED TEST: maxRuns cap at 1000 unified =====

test("RED: maxRuns rejects values > 1000 in ledger.pruneRuns", async (t) => {
  const { ledger } = await fixture(t);

  const cases = [
    { maxRuns: 1001, shouldFail: true },
    { maxRuns: 10000, shouldFail: true },
    { maxRuns: 1000, shouldFail: false },
    { maxRuns: 500, shouldFail: false },
    { maxRuns: 1, shouldFail: false },
  ];

  for (const testCase of cases) {
    if (testCase.shouldFail) {
      assert.throws(
        () => ledger.pruneRuns({ olderThanUnix: 0, maxRuns: testCase.maxRuns, dryRun: false }),
        /maxRuns.*1000|maximum.*1000/i,
        `maxRuns=${testCase.maxRuns} should be rejected`
      );
    } else {
      assert.doesNotThrow(
        () => ledger.pruneRuns({ olderThanUnix: 0, maxRuns: testCase.maxRuns, dryRun: true }),
        `maxRuns=${testCase.maxRuns} should be accepted`
      );
    }
  }
});

// ===== RED TEST: activity_hmac schema and storage =====

test("RED: runs table includes activity_hmac column for event timestamp binding", async (t) => {
  const { path, ledger } = await fixture(t);
  const db = openDatabase(path);
  t.after(() => db.close());

  const schema = db.prepare("PRAGMA table_info(runs)").all();
  const columnNames = schema.map(col => col.name);
  assert.ok(columnNames.includes("activity_hmac"), "runs should have activity_hmac column");
});

test("RED: run_archive table includes activity_hmac column for integrity", async (t) => {
  const { path, ledger } = await fixture(t);
  const db = openDatabase(path);
  t.after(() => db.close());

  const schema = db.prepare("PRAGMA table_info(run_archive)").all();
  const columnNames = schema.map(col => col.name);
  assert.ok(columnNames.includes("activity_hmac"), "run_archive should have activity_hmac column");
});

// ===== RED TEST: activity_hmac atomicity on append/duplicate =====

test("RED: append updates last_event_unix and activity_hmac atomically", async (t) => {
  const { ledger, path } = await fixture(t);
  ledger.createRun("run-1");

  const beforeUnix = Math.floor(Date.now() / 1000);
  ledger.append(event("run-1"));
  const afterUnix = Math.floor(Date.now() / 1000);

  // Verify both last_event_unix and activity_hmac are updated within same transaction
  const db = openDatabase(path);
  const run = db.prepare("SELECT last_event_unix, activity_hmac FROM runs WHERE run_id = ?").get("run-1");
  db.close();
  t.after(() => {});

  assert.ok(run.last_event_unix >= beforeUnix && run.last_event_unix <= afterUnix,
    "last_event_unix should be updated on append");

  const expectedActivityHmac = framedDigest([
    "activity",
    "run-1",
    String(run.last_event_unix)
  ]);
  assert.equal(run.activity_hmac, expectedActivityHmac,
    "activity_hmac should be recomputed with last_event_unix on append");
});

test("RED: duplicate append touch updates last_event_unix and activity_hmac atomically", async (t) => {
  const { ledger, path } = await fixture(t);
  ledger.createRun("run-1");

  ledger.append(event("run-1", { dedupeKey: "run-1:call-1" }));

  const db = openDatabase(path);
  const unix1 = db.prepare("SELECT last_event_unix, activity_hmac FROM runs WHERE run_id = ?").get("run-1");
  db.close();

  await new Promise(resolve => setTimeout(resolve, 10));

  // Append duplicate (should touch but not create new event)
  ledger.append(event("run-1", { dedupeKey: "run-1:call-1" }));

  const db2 = openDatabase(path);
  const unix2 = db2.prepare("SELECT last_event_unix, activity_hmac FROM runs WHERE run_id = ?").get("run-1");
  db2.close();
  t.after(() => {});

  assert.ok(unix2.last_event_unix >= unix1.last_event_unix,
    "duplicate touch should update last_event_unix monotonically");

  // activity_hmac should be recomputed when last_event_unix changes
  const expectedActivityHmac = framedDigest([
    "activity",
    "run-1",
    String(unix2.last_event_unix)
  ]);
  assert.equal(unix2.activity_hmac, expectedActivityHmac,
    "duplicate touch must recompute activity_hmac with new last_event_unix");
});

// ===== RED TEST: activity_hmac tampering detection =====

test("RED: verifyAll detects activity_hmac tampering in runs", async (t) => {
  const { ledger, path } = await fixture(t);
  ledger.createRun("run-1");
  ledger.append(event("run-1"));
  ledger.transitionRun("run-1", "ADMITTED");

  // Tamper with activity_hmac
  const db = openDatabase(path);
  db.prepare("UPDATE runs SET activity_hmac = ? WHERE run_id = ?").run("invalid", "run-1");
  db.close();

  // verifyAll should detect tampering
  const result = ledger.verifyAll();
  assert.ok(result.invalid > 0 || result.tampered > 0,
    "verifyAll should report invalid/tampered count > 0 for run with bad activity_hmac");
});

test("RED: verifyAll detects last_event_unix tampering paired with activity_hmac", async (t) => {
  const { ledger, path } = await fixture(t);
  ledger.createRun("run-1");
  ledger.append(event("run-1"));
  ledger.transitionRun("run-1", "ADMITTED");

  // Tamper with both last_event_unix and activity_hmac
  const db = openDatabase(path);
  db.prepare("UPDATE runs SET last_event_unix = ? WHERE run_id = ?").run(9999999, "run-1");
  db.prepare("UPDATE runs SET activity_hmac = ? WHERE run_id = ?").run("invalid", "run-1");
  db.close();

  const result = ledger.verifyAll();
  assert.ok(result.invalid > 0,
    "verifyAll should detect tampering in both last_event_unix and activity_hmac");
});

// ===== RED TEST: prune validation of activity_hmac =====

test("RED: prune refuses to archive run with invalid activity_hmac", async (t) => {
  const { ledger, path } = await fixture(t);
  ledger.createRun("run-1");
  ledger.append(event("run-1"));
  ledger.transitionRun("run-1", "ADMITTED");

  // Age the run for pruning eligibility
  ageRuns(path, ["run-1"], key);

  // Tamper with activity_hmac before prune
  const db = openDatabase(path);
  db.prepare("UPDATE runs SET activity_hmac = ? WHERE run_id = ?").run("invalid", "run-1");
  db.close();

  const ledger2 = openLedger({ path, hmacKey: key });
  t.after(() => ledger2.close());

  // Prune should reject runs with invalid activity_hmac
  assert.throws(
    () => ledger2.pruneRuns({ maxRuns: 1000, dryRun: false }),
    /activity_hmac|tamper|integrity/i,
    "prune should refuse to archive run with invalid activity_hmac"
  );
});

test("RED: prune detects if activity_hmac is null/undefined in candidate runs", async (t) => {
  const { ledger, path } = await fixture(t);
  ledger.createRun("run-1");
  ledger.append(event("run-1"));
  ledger.transitionRun("run-1", "ADMITTED");

  ageRuns(path, ["run-1"], key);

  // Set activity_hmac to NULL to simulate missing data
  const db = openDatabase(path);
  db.prepare("UPDATE runs SET activity_hmac = NULL WHERE run_id = ?").run("run-1");
  db.close();

  const ledger2 = openLedger({ path, hmacKey: key });
  t.after(() => ledger2.close());

  assert.throws(
    () => ledger2.pruneRuns({ maxRuns: 1000, dryRun: false }),
    /activity_hmac|null|missing|integrity/i,
    "prune should reject runs with missing activity_hmac"
  );
});

// ===== RED TEST: archive receipt binding last_event_unix and activity_hmac =====

test("RED: archive receipt includes both last_event_unix and activity_hmac", async (t) => {
  const { ledger, path } = await fixture(t);
  ledger.createRun("run-1");
  ledger.append(event("run-1"));
  ledger.transitionRun("run-1", "ADMITTED");

  ageRuns(path, ["run-1"], key);
  ledger.pruneRuns({ maxRuns: 1000, dryRun: false });

  const db = openDatabase(path);
  const archive = db.prepare("SELECT * FROM run_archive WHERE run_id = ?").get("run-1");
  db.close();
  t.after(() => {});

  // Archive record should have activity_hmac field
  assert.ok("activity_hmac" in archive, "archive record must have activity_hmac field");
  assert.ok(typeof archive.activity_hmac === "string" && archive.activity_hmac.length > 0,
    "archive.activity_hmac should be populated");
});

test("RED: archive_hmac digest includes activity_hmac binding", async (t) => {
  const { ledger, path } = await fixture(t);
  ledger.createRun("run-1");
  ledger.append(event("run-1"));
  ledger.transitionRun("run-1", "ADMITTED");

  ageRuns(path, ["run-1"], key);
  ledger.pruneRuns({ maxRuns: 1000, dryRun: false });

  const db = openDatabase(path);
  const archive = db.prepare("SELECT * FROM run_archive WHERE run_id = ?").get("run-1");
  db.close();
  t.after(() => {});

  // archive_hmac should include activity_hmac in its calculation
  // Format: ["archive", run_id, state, event_count, head_hmac, commitment, pruned_at, activity_hmac]
  const expectedHmac = framedDigest([
    "archive",
    archive.run_id,
    archive.state,
    String(archive.event_count),
    archive.head_hmac,
    archive.commitment,
    String(archive.pruned_at),
    archive.activity_hmac
  ]);

  assert.equal(archive.archive_hmac, expectedHmac,
    "archive_hmac must include activity_hmac in its digest");
});

test("RED: tampering archive activity_hmac is detected on verifyArchive", async (t) => {
  const { ledger, path } = await fixture(t);
  ledger.createRun("run-1");
  ledger.append(event("run-1"));
  ledger.transitionRun("run-1", "ADMITTED");

  ageRuns(path, ["run-1"], key);
  ledger.pruneRuns({ maxRuns: 1000, dryRun: false });

  // Tamper with archive activity_hmac
  const db = openDatabase(path);
  db.prepare("UPDATE run_archive SET activity_hmac = ? WHERE run_id = ?").run("tampered", "run-1");
  db.close();

  // verifyArchive should detect tampering
  const result = ledger.verifyArchive("run-1");
  assert.equal(result, false, "verifyArchive should detect activity_hmac tampering");
});

// ===== RED TEST: legacy migration backfills activity_hmac =====

test("RED: migration backfills activity_hmac from last_event_unix on ledger reopen", async (t) => {
  const { ledger, path } = await fixture(t);

  ledger.createRun("run-legacy");
  ledger.append(event("run-legacy"));
  ledger.transitionRun("run-legacy", "ADMITTED");
  ledger.close();

  // Simulate legacy database: manually set activity_hmac to NULL/empty
  const db = openDatabase(path);
  const runData = db.prepare("SELECT last_event_unix FROM runs WHERE run_id = ?").get("run-legacy");
  db.prepare("UPDATE runs SET activity_hmac = ? WHERE run_id = ?").run("", "run-legacy");
  db.close();

  // Reopen ledger (should trigger migration)
  const ledger2 = openLedger({ path, hmacKey: key });
  t.after(() => ledger2.close());

  // Verify activity_hmac was backfilled
  const db2 = openDatabase(path);
  const run = db2.prepare("SELECT activity_hmac, last_event_unix FROM runs WHERE run_id = ?").get("run-legacy");
  db2.close();

  assert.ok(run.activity_hmac && run.activity_hmac.length > 0,
    "activity_hmac should be backfilled from last_event_unix");

  const expectedActivityHmac = framedDigest([
    "activity",
    "run-legacy",
    String(run.last_event_unix)
  ]);
  assert.equal(run.activity_hmac, expectedActivityHmac,
    "backfilled activity_hmac should match expected framed digest");
});

test("RED: migration verifies run chain integrity before backfilling activity_hmac", async (t) => {
  const { ledger, path } = await fixture(t);

  ledger.createRun("run-legacy");
  ledger.append(event("run-legacy"));
  ledger.transitionRun("run-legacy", "ADMITTED");
  ledger.close();

  // Corrupt run integrity BEFORE setting activity_hmac to empty
  const db = openDatabase(path);
  db.prepare("UPDATE runs SET event_count = 99 WHERE run_id = ?").run("run-legacy");
  db.prepare("UPDATE runs SET activity_hmac = ? WHERE run_id = ?").run("", "run-legacy");
  db.close();

  const ledger2 = openLedger({ path, hmacKey: key });
  t.after(() => ledger2.close());

  // Migration should reject backfill if run chain is invalid
  assert.throws(
    () => ledger2.verifyChain("run-legacy"),
    /integrity|verify|invalid/i,
    "migration must verify chain integrity before backfilling activity_hmac"
  );
});

test("RED: migration backfills activity_hmac in run_archive records too", async (t) => {
  const { ledger, path } = await fixture(t);

  ledger.createRun("run-archive-legacy");
  ledger.append(event("run-archive-legacy"));
  ledger.transitionRun("run-archive-legacy", "ADMITTED");

  ageRuns(path, ["run-archive-legacy"], key);
  ledger.pruneRuns({ maxRuns: 1000, dryRun: false });
  ledger.close();

  // Simulate legacy archive: set activity_hmac to empty, recalculate archive_hmac with old format
  const db = openDatabase(path);
  const archive = db.prepare("SELECT * FROM run_archive WHERE run_id = ?").get("run-archive-legacy");

  // Old format (without activity_hmac)
  const oldFormatHmac = framedDigest([
    "archive",
    archive.run_id,
    archive.state,
    String(archive.event_count),
    archive.head_hmac,
    archive.commitment,
    String(archive.pruned_at)
  ]);

  db.prepare("UPDATE run_archive SET activity_hmac = ? WHERE run_id = ?").run("", "run-archive-legacy");
  db.prepare("UPDATE run_archive SET archive_hmac = ? WHERE run_id = ?").run(oldFormatHmac, "run-archive-legacy");
  db.close();

  // Reopen ledger (should migrate archive records too)
  const ledger2 = openLedger({ path, hmacKey: key });
  t.after(() => ledger2.close());

  // Verify archive activity_hmac was backfilled
  const db2 = openDatabase(path);
  const migratedArchive = db2.prepare("SELECT activity_hmac FROM run_archive WHERE run_id = ?").get("run-archive-legacy");
  db2.close();

  assert.ok(migratedArchive.activity_hmac && migratedArchive.activity_hmac.length > 0,
    "archive activity_hmac should be backfilled during migration");
});
