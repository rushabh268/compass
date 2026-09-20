import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { fork } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, readFile, stat, symlink } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";

import { openDatabase } from "../../src/state/database.mjs";
import { openLedger } from "../../src/state/ledger.mjs";

const key = Buffer.alloc(32, 0xa5);
const lockHolderPath = new URL("../../fixtures/state/lock-holder.mjs", import.meta.url);

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
  const root = await mkdir(join(tmpdir(), `compass-${process.pid}-${Date.now()}-${Math.random()}`), { recursive: true });
  const path = join(root, "private", "ledger.sqlite");
  const ledger = openLedger({ path, hmacKey: key });
  t.after(() => ledger.close());
  return { ledger, path, root };
}

function hmac(values) {
  const digest = createHmac("sha256", key);
  for (const value of values) {
    const bytes = Buffer.from(value, "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length);
    digest.update(length).update(bytes);
  }
  return digest.digest("hex");
}

async function waitForMessage(child, timeout = 2_000) {
  const timer = new Promise((_, reject) => {
    const id = setTimeout(() => reject(new Error("lock holder timed out")), timeout);
    id.unref();
  });
  return Promise.race([once(child, "message").then(([message]) => message), timer]);
}

test("opens a hardened SQLite database with required settings", async (t) => {
  const { path, root } = await fixture(t);
  const parent = join(root, "private");
  assert.equal((await stat(parent)).mode & 0o777, 0o700);
  assert.equal((await stat(path)).mode & 0o777, 0o600);

  const db = openDatabase(path);
  t.after(() => db.close());
  assert.equal(db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  assert.equal(db.prepare("PRAGMA synchronous").get().synchronous, 2);
  assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
});

test("rejects a symlinked database parent path", async () => {
  const root = await mkdir(join(tmpdir(), `compass-parent-link-${process.pid}-${Date.now()}`), { recursive: true });
  const target = join(root, "target");
  await mkdir(target, { mode: 0o700 });
  const parent = join(root, "private");
  await symlink(target, parent, "dir");

  assert.throws(() => openLedger({ path: join(parent, "ledger.sqlite"), hmacKey: key }), /symlink/i);
});

test("rejects an existing database symlink", async () => {
  const root = await mkdir(join(tmpdir(), `compass-db-link-${process.pid}-${Date.now()}`), { recursive: true });
  const target = join(root, "target.sqlite");
  new DatabaseSync(target).close();
  const path = join(root, "ledger.sqlite");
  await symlink(target, path, "file");

  assert.throws(() => openLedger({ path, hmacKey: key }), /symlink/i);
});

test("rejects an existing database parent not mode 0700 without chmodding it", async () => {
  const root = await mkdir(join(tmpdir(), `compass-parent-mode-${process.pid}-${Date.now()}`), { recursive: true });
  const parent = join(root, "private");
  await mkdir(parent, { mode: 0o700 });
  await chmod(parent, 0o755);

  assert.throws(() => openLedger({ path: join(parent, "ledger.sqlite"), hmacKey: key }), /0700|permission|mode/i);
  assert.equal((await stat(parent)).mode & 0o777, 0o755);
});

test("configures a positive bounded SQLite busy timeout", async (t) => {
  const { path } = await fixture(t);
  const db = openDatabase(path);
  t.after(() => db.close());
  const timeout = db.prepare("PRAGMA busy_timeout").get().timeout;
  assert.ok(timeout > 0 && timeout <= 5_000, `busy_timeout must be in (0, 5000], got ${timeout}`);
});

test("rejects invalid HMAC keys", async () => {
  const root = await mkdir(join(tmpdir(), `compass-key-${process.pid}-${Date.now()}`), { recursive: true });
  const path = join(root, "ledger.sqlite");
  for (const hmacKey of [undefined, "secret", Buffer.alloc(31), new Uint8Array(0)]) {
    assert.throws(() => openLedger({ path, hmacKey }), /hmacKey/i);
  }
});

test("persists runs and events across reopen", async () => {
  const root = await mkdir(join(tmpdir(), `compass-reopen-${process.pid}-${Date.now()}`), { recursive: true });
  const path = join(root, "ledger.sqlite");
  let ledger = openLedger({ path, hmacKey: key });
  ledger.createRun("run-1");
  ledger.transitionRun("run-1", "ADMITTED");
  const receipt = ledger.append(event("run-1"));
  ledger.close();

  ledger = openLedger({ path, hmacKey: key });
  assert.equal(ledger.transitionRun("run-1", "ACTIVE").state, "ACTIVE");
  assert.deepEqual(ledger.listEvents("run-1"), [receipt.event]);
  assert.equal(ledger.verifyChain("run-1"), true);
  ledger.close();
});

test("ensureRun creates a missing run and returns an existing run idempotently", async (t) => {
  const { ledger } = await fixture(t);
  assert.deepEqual(ledger.ensureRun("run-1"), { runID: "run-1", state: "CREATED", created: true });
  ledger.transitionRun("run-1", "ADMITTED");
  assert.deepEqual(ledger.ensureRun("run-1"), { runID: "run-1", state: "ADMITTED", created: false });
  assert.deepEqual(ledger.listEvents("run-1"), []);
});

test("deduplicates atomically and returns the existing receipt", async (t) => {
  const { ledger } = await fixture(t);
  ledger.createRun("run-1");
  const input = event("run-1");
  const first = ledger.append(input);
  const duplicate = ledger.append(input);

  assert.equal(first.inserted, true);
  assert.deepEqual(duplicate, { ...first, inserted: false });
  assert.equal(ledger.listEvents("run-1").length, 1);
});

test("rejects a dedupe key reused for a different canonical event", async (t) => {
  const { ledger } = await fixture(t);
  ledger.createRun("run-1");
  ledger.append(event("run-1"));

  assert.throws(
    () => ledger.append(event("run-1", { eventID: "different" })),
    /dedupe key conflict/,
  );
  assert.equal(ledger.listEvents("run-1").length, 1);
});

test("waits for a child-held write lock and returns the winning duplicate receipt", { timeout: 5_000 }, async (t) => {
  const { ledger, path } = await fixture(t);
  ledger.createRun("run-1");
  const winner = event("run-1");
  const body = JSON.stringify(winner);
  const child = fork(lockHolderPath, [path, body, key.toString("hex"), "250"], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  t.after(() => child.kill());
  const message = await waitForMessage(child);
  assert.equal(message.status, "locked");

  const contender = openLedger({ path, hmacKey: key });
  t.after(() => contender.close());
  const started = Date.now();
  const duplicate = contender.append(winner);

  assert.ok(Date.now() - started >= 100, "contending ledger should wait for the write lock");
  assert.deepEqual(duplicate, { ...message.receipt, inserted: false });
  assert.equal(contender.verifyChain("run-1"), true);
});

test("maintains independent per-run HMAC chains", async (t) => {
  const { ledger } = await fixture(t);
  for (const runID of ["run-1", "run-2"]) ledger.createRun(runID);
  const one = ledger.append(event("run-1"));
  const two = ledger.append(event("run-2"));
  const next = ledger.append(event("run-1", {
    eventID: "run-1-event-2",
    dedupeKey: "run-1:call-2",
    sequence: 1,
  }));

  assert.equal(one.previousHMAC, "");
  assert.equal(two.previousHMAC, "");
  assert.equal(next.previousHMAC, one.hmac);
  assert.equal(ledger.verifyChain("run-1"), true);
  assert.equal(ledger.verifyChain("run-2"), true);
});

test("appends 2,000 events within a constant-time head-check budget", { timeout: 30_000 }, async (t) => {
  const { ledger } = await fixture(t);
  ledger.createRun("run-1");
  const started = performance.now();

  for (let index = 0; index < 2_000; index += 1) {
    ledger.append(event("run-1", {
      eventID: `run-1-event-${index}`,
      dedupeKey: `run-1:call-${index}`,
    }));
  }

  const elapsed = performance.now() - started;
  assert.ok(elapsed < 5_000, `2,000 appends took ${elapsed.toFixed(0)}ms; expected less than 5000ms`);
  assert.equal(ledger.verifyChain("run-1"), true);
});

test("detects tampering and a wrong key", async () => {
  const root = await mkdir(join(tmpdir(), `compass-tamper-${process.pid}-${Date.now()}`), { recursive: true });
  const path = join(root, "ledger.sqlite");
  let ledger = openLedger({ path, hmacKey: key });
  ledger.createRun("run-1");
  ledger.append(event("run-1"));
  ledger.close();

  ledger = openLedger({ path, hmacKey: Buffer.alloc(32, 0xb6) });
  assert.equal(ledger.verifyChain("run-1"), false);
  ledger.close();

  const db = new DatabaseSync(path);
  db.exec("UPDATE events SET body = replace(body, 'PreToolUse', 'PostToolUse')");
  db.close();
  ledger = openLedger({ path, hmacKey: key });
  assert.equal(ledger.verifyChain("run-1"), false);
  ledger.close();
});

test("rejects transitions after direct run state tampering", async () => {
  const path = join(tmpdir(), `compass-state-tamper-${process.pid}-${Date.now()}.sqlite`);
  let ledger = openLedger({ path, hmacKey: key });
  ledger.createRun("run-1");
  ledger.close();

  const db = new DatabaseSync(path);
  db.exec("UPDATE runs SET state = 'ADMITTED' WHERE run_id = 'run-1'");
  db.close();

  ledger = openLedger({ path, hmacKey: key });
  assert.equal(ledger.verifyChain("run-1"), false);
  assert.throws(() => ledger.transitionRun("run-1", "ACTIVE"), /integrity/i);
  ledger.close();
});

test("rejects listing events after event body tampering", async () => {
  const path = join(tmpdir(), `compass-list-tamper-${process.pid}-${Date.now()}.sqlite`);
  let ledger = openLedger({ path, hmacKey: key });
  ledger.createRun("run-1");
  ledger.append(event("run-1"));
  ledger.close();

  const db = new DatabaseSync(path);
  db.exec("UPDATE events SET body = replace(body, 'PreToolUse', 'PostToolUse')");
  db.close();

  ledger = openLedger({ path, hmacKey: key });
  assert.throws(() => ledger.listEvents("run-1"), /integrity/i);
  ledger.close();
});

test("detects deletion of the tail event", async () => {
  const path = join(tmpdir(), `compass-tail-delete-${process.pid}-${Date.now()}.sqlite`);
  let ledger = openLedger({ path, hmacKey: key });
  ledger.createRun("run-1");
  ledger.append(event("run-1"));
  ledger.append(event("run-1", { eventID: "run-1-event-2", dedupeKey: "run-1:call-2" }));
  ledger.close();

  const db = new DatabaseSync(path);
  db.exec("DELETE FROM events WHERE id = (SELECT max(id) FROM events WHERE run_id = 'run-1')");
  db.close();

  ledger = openLedger({ path, hmacKey: key });
  assert.equal(ledger.verifyChain("run-1"), false);
  ledger.close();
});

test("rejects append when the authenticated run head is inconsistent", async (t) => {
  for (const [name, tamper] of [
    ["deleted tail", "DELETE FROM events WHERE id = (SELECT max(id) FROM events WHERE run_id = 'run-1')"],
    ["tampered commitment", "UPDATE runs SET commitment = 'tampered' WHERE run_id = 'run-1'"],
  ]) {
    await t.test(name, () => {
      const path = join(tmpdir(), `compass-append-head-${process.pid}-${Date.now()}-${Math.random()}.sqlite`);
      let ledger = openLedger({ path, hmacKey: key });
      ledger.createRun("run-1");
      ledger.append(event("run-1"));
      ledger.append(event("run-1", { eventID: "run-1-event-2", dedupeKey: "run-1:call-2" }));
      ledger.close();

      const db = new DatabaseSync(path);
      db.exec(tamper);
      db.close();

      ledger = openLedger({ path, hmacKey: key });
      assert.throws(
        () => ledger.append(event("run-1", { eventID: "run-1-event-3", dedupeKey: "run-1:call-3" })),
        /integrity/i,
      );
      ledger.close();
    });
  }
});

test("threat model defines constant-time append integrity boundaries", async () => {
  const threatModel = await readFile(new URL("../../docs/threat-model.md", import.meta.url), "utf8");

  assert.match(
    threatModel,
    /Append verifies the authenticated head and run commitment; full-chain validation occurs on reads and audits, while coordinated rollback remains out of scope\./,
  );
});

test("detects deletion of all events from a nonempty run", async () => {
  const path = join(tmpdir(), `compass-all-delete-${process.pid}-${Date.now()}.sqlite`);
  let ledger = openLedger({ path, hmacKey: key });
  ledger.createRun("run-1");
  ledger.append(event("run-1"));
  ledger.close();

  const db = new DatabaseSync(path);
  db.exec("DELETE FROM events WHERE run_id = 'run-1'");
  db.close();

  ledger = openLedger({ path, hmacKey: key });
  assert.equal(ledger.verifyChain("run-1"), false);
  ledger.close();
});

test("rejects a tampered duplicate instead of returning a receipt", async () => {
  const path = join(tmpdir(), `compass-duplicate-tamper-${process.pid}-${Date.now()}.sqlite`);
  let ledger = openLedger({ path, hmacKey: key });
  ledger.createRun("run-1");
  ledger.append(event("run-1"));
  ledger.close();

  const db = new DatabaseSync(path);
  db.exec("UPDATE events SET body = replace(body, 'PreToolUse', 'PostToolUse')");
  db.close();

  ledger = openLedger({ path, hmacKey: key });
  assert.throws(() => ledger.append(event("run-1", { eventID: "duplicate" })), /integrity/i);
  ledger.close();
});

test("detects tampering of run integrity metadata", async (t) => {
  for (const [column, value] of [
    ["event_count", 99],
    ["head_hmac", "tampered"],
    ["commitment", "tampered"],
  ]) {
    await t.test(column, () => {
      const path = join(tmpdir(), `compass-run-${column}-${process.pid}-${Date.now()}.sqlite`);
      let ledger = openLedger({ path, hmacKey: key });
      ledger.createRun("run-1");
      ledger.append(event("run-1"));
      ledger.close();

      const db = new DatabaseSync(path);
      db.prepare(`UPDATE runs SET ${column} = ? WHERE run_id = 'run-1'`).run(value);
      db.close();

      ledger = openLedger({ path, hmacKey: key });
      assert.equal(ledger.verifyChain("run-1"), false);
      ledger.close();
    });
  }
});

test("detects tampering of persisted run_id and dedupe_key columns", async (t) => {
  for (const [column, value, runID] of [
    ["run_id", "run-2", "run-2"],
    ["dedupe_key", "tampered", "run-1"],
  ]) {
    await t.test(column, () => {
      const path = join(tmpdir(), `compass-column-${column}-${process.pid}-${Date.now()}.sqlite`);
      let ledger = openLedger({ path, hmacKey: key });
      ledger.createRun("run-1");
      if (column === "run_id") ledger.createRun("run-2");
      ledger.append(event("run-1"));
      ledger.close();

      const db = new DatabaseSync(path);
      db.prepare(`UPDATE events SET ${column} = ?`).run(value);
      db.close();
      ledger = openLedger({ path, hmacKey: key });
      assert.equal(ledger.verifyChain(runID), false);
      ledger.close();
    });
  }
});

test("requires body runID and dedupeKey to match persisted columns", async (t) => {
  for (const [field, value] of [
    ["runID", "run-2"],
    ["dedupeKey", "body-tampered"],
  ]) {
    await t.test(field, () => {
      const path = join(tmpdir(), `compass-body-${field}-${process.pid}-${Date.now()}.sqlite`);
      let ledger = openLedger({ path, hmacKey: key });
      ledger.createRun("run-1");
      ledger.append(event("run-1"));
      ledger.close();

      const db = new DatabaseSync(path);
      const row = db.prepare("SELECT run_id, dedupe_key, body, previous_hmac FROM events").get();
      const changedBody = JSON.stringify({ ...JSON.parse(row.body), [field]: value });
      const changedHMAC = hmac([row.previous_hmac, row.run_id, row.dedupe_key, changedBody]);
      const commitment = hmac(["run", "run-1", "CREATED", "1", changedHMAC]);
      db.prepare("UPDATE events SET body = ?, hmac = ?").run(changedBody, changedHMAC);
      db.prepare("UPDATE runs SET head_hmac = ?, commitment_hmac = ?, commitment = ? WHERE run_id = 'run-1'")
        .run(changedHMAC, commitment, commitment);
      const authenticated = db.prepare("SELECT hmac FROM events").get();
      const authenticatedRun = db.prepare("SELECT head_hmac, commitment_hmac, commitment FROM runs WHERE run_id = 'run-1'").get();
      assert.equal(authenticated.hmac, hmac([row.previous_hmac, row.run_id, row.dedupe_key, changedBody]));
      assert.equal(authenticatedRun.head_hmac, changedHMAC);
      assert.equal(authenticatedRun.commitment_hmac, commitment);
      assert.equal(authenticatedRun.commitment, commitment);
      db.close();
      ledger = openLedger({ path, hmacKey: key });
      assert.equal(ledger.verifyChain("run-1"), false);
      ledger.close();
    });
  }
});

test("rejects unknown runs, illegal transitions, and invalid events without partial writes", async (t) => {
  const { ledger } = await fixture(t);
  assert.throws(() => ledger.transitionRun("missing", "ADMITTED"), /unknown run/i);
  assert.throws(() => ledger.append(event("missing")), /unknown run/i);
  ledger.createRun("run-1");
  assert.throws(() => ledger.transitionRun("run-1", "ACTIVE"), /transition/i);
  assert.throws(() => ledger.append({ ...event("run-1"), rawPrompt: "secret" }), /unknown field/i);
  assert.equal(ledger.transitionRun("run-1", "ADMITTED").state, "ADMITTED");
  assert.deepEqual(ledger.listEvents("run-1"), []);
});

test("rolls back failed transactions", async (t) => {
  const { ledger } = await fixture(t);
  ledger.createRun("run-1");
  assert.throws(() => ledger.createRun("run-1"));

  assert.equal(ledger.transitionRun("run-1", "ADMITTED").state, "ADMITTED");
  assert.equal(ledger.append(event("run-1")).inserted, true);
  assert.equal(ledger.verifyChain("run-1"), true);
});

test("never stores the HMAC key in database bytes", async (t) => {
  const visibleKey = Buffer.from("0123456789abcdef0123456789abcdef");
  const { path } = await fixture(t);
  const separatePath = `${path}.key-check`;
  const ledger = openLedger({ path: separatePath, hmacKey: visibleKey });
  ledger.createRun("run-1");
  ledger.append(event("run-1"));
  ledger.close();
  const bytes = await readFile(separatePath);
  assert.equal(bytes.includes(visibleKey), false);
});

test("returns immutable detached values", async (t) => {
  const { ledger } = await fixture(t);
  const run = ledger.createRun("run-1");
  const receipt = ledger.append(event("run-1", { decision: {
    schemaVersion: 1,
    action: "allow",
    ruleIDs: ["policy.allow"],
    reason: "allowed",
  } }));
  const listed = ledger.listEvents("run-1");

  for (const value of [run, receipt, receipt.event, receipt.event.decision, receipt.event.decision.ruleIDs, listed, listed[0], listed[0].decision, listed[0].decision.ruleIDs]) {
    assert.equal(Object.isFrozen(value), true);
  }
  assert.throws(() => { listed[0].eventType = "changed"; }, TypeError);
  assert.equal(ledger.listEvents("run-1")[0].eventType, "PreToolUse");
});

test("listEventsPage returns byte-bounded pages while verifying and retrieving the full chain", async (t) => {
  const { ledger } = await fixture(t);
  ledger.createRun("run-1");
  const expected = Array.from({ length: 7 }, (_, index) => event("run-1", {
    eventID: `run-1-event-${index}`,
    dedupeKey: `run-1:call-${index}`,
    toolName: "a".repeat(64),
  }));
  for (const item of expected) ledger.append(item);

  const events = [];
  let cursor = 0;
  do {
    const page = ledger.listEventsPage("run-1", { cursor, limit: 5, maxBytes: 700 });
    assert.deepEqual(Object.keys(page).sort(), ["events", "nextCursor"]);
    assert.ok(page.events.length > 0 && page.events.length <= 5);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 700);
    assert.equal(ledger.verifyChain("run-1"), true);
    events.push(...page.events);
    cursor = page.nextCursor;
  } while (cursor !== null);

  assert.deepEqual(events, expected);
});

test("status returns frozen aggregate metadata without run ids or event content", async (t) => {
  const { ledger } = await fixture(t);
  ledger.createRun("status-run-1");
  ledger.transitionRun("status-run-1", "ADMITTED");
  ledger.append(event("status-run-1"));
  ledger.createRun("status-run-2");
  ledger.append(event("status-run-2", {
    eventID: "status-run-2-event-1",
    dedupeKey: "status-run-2:call-1",
  }));

  const status = ledger.status();

  assert.deepEqual(status, {
    runs: 2,
    events: 2,
    states: { ADMITTED: 1, CREATED: 1 },
  });
  assert.deepEqual(Object.keys(status).sort(), ["events", "runs", "states"]);
  assert.equal(Object.isFrozen(status), true);
  assert.equal(Object.isFrozen(status.states), true);
  assert.equal(JSON.stringify(status).includes("status-run-1"), false);
  assert.equal(JSON.stringify(status).includes("status-run-2-event-1"), false);
  assert.throws(() => { status.runs = 99; }, TypeError);
  assert.throws(() => { status.states.CREATED = 99; }, TypeError);
});

test("verifyAll returns valid and invalid run counts without raw identifiers or content", async (t) => {
  const { ledger, path } = await fixture(t);
  ledger.createRun("verify-run-valid");
  ledger.append(event("verify-run-valid"));
  ledger.createRun("verify-run-invalid");
  ledger.append(event("verify-run-invalid", {
    eventID: "verify-run-invalid-event-1",
    dedupeKey: "verify-run-invalid:call-1",
  }));
  ledger.close();

  const db = new DatabaseSync(path);
  db.exec("UPDATE events SET body = replace(body, 'PreToolUse', 'PostToolUse') WHERE run_id = 'verify-run-invalid'");
  db.close();

  const reopened = openLedger({ path, hmacKey: key });
  t.after(() => reopened.close());
  const result = reopened.verifyAll();

  assert.deepEqual(result, { valid: 1, invalid: 1 });
  assert.deepEqual(Object.keys(result).sort(), ["invalid", "valid"]);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("verify-run-valid"), false);
  assert.equal(serialized.includes("verify-run-invalid"), false);
  assert.equal(serialized.includes("PreToolUse"), false);
});
