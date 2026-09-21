import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "../src/state/database.mjs";
import { openLedger } from "../src/state/ledger.mjs";
import { authenticateRequest, createRequest } from "../src/protocol/rpc.mjs";
import { translateClaudeHook } from "../adapters/claude/translate.mjs";
import { createEventCoalescer } from "../adapters/opencode/coalescer.mjs";

// Captured from the public baseline named in the fixture, using synthetic data
// and Buffer.alloc(32, 0xa5). These values must not change with product branding.
const legacy = JSON.parse(await readFile(new URL("./fixtures/compatibility/legacy-ledger.json", import.meta.url), "utf8"));
const key = Buffer.alloc(32, 0xa5);

test("legacy ledger rows authenticate and replay without regenerating history", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "compass-history-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const path = join(home, "private", "events.sqlite");
  const db = openDatabase(path);
  for (const table of ["runs", "events"]) {
    for (const row of legacy.rows[table]) {
      const columns = Object.keys(row);
      db.prepare(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`).run(...Object.values(row));
    }
  }
  db.close();
  const ledger = openLedger({ path, hmacKey: key });
  try {
    assert.equal(ledger.verifyChain(legacy.translated.runID), true);
    assert.deepEqual(ledger.listEvents(legacy.translated.runID), [legacy.translated]);
    assert.deepEqual(ledger.append(legacy.translated), { ...legacy.receipt, inserted: false });
  } finally { ledger.close(); }
});

test("legacy native event identities and authenticated RPC bytes are stable", () => {
  assert.deepEqual(translateClaudeHook(legacy.input, { authKey: key, now: new Date(legacy.translated.timestamp) }), legacy.translated);
  assert.deepEqual(createRequest({ id: "synthetic-request", method: "health", params: {}, authKey: key }), legacy.rpc);
  assert.equal(authenticateRequest(legacy.rpc, key), true);
  assert.equal(authenticateRequest(legacy.rpc, Buffer.alloc(32, 0xa6)), false);
});

test("explicit legacy no-epoch coalescer preserves fallback key and HarnessMetrics bytes", async () => {
  const events = [];
  const coalescer = createEventCoalescer({
    // Empty epoch explicitly selects the historical unscoped identity contract.
    retentionEpoch: "",
    enqueue: (event) => { events.push(event); return true; },
    now: () => new Date("2026-08-24T12:00:00.000Z"),
    setTimeout: () => ({ unref() {} }), clearTimeout() {},
  });
  coalescer.push({ schemaVersion: 1, eventID: "synthetic-global", runID: "global", platform: "opencode", sessionHMAC: "1".repeat(64), eventType: "FileEdit", timestamp: "2026-08-24T12:00:00.000Z", dedupeKey: "synthetic-global" });
  await coalescer.dispose();
  assert.deepEqual(events, legacy.summary);
});


test("default monthly coalescer identity intentionally differs from the legacy no-epoch fixture", async () => {
  const events = [];
  const coalescer = createEventCoalescer({
    enqueue: (event) => { events.push(event); return true; },
    now: () => new Date("2026-08-24T12:00:00.000Z"),
    setTimeout: () => ({ unref() {} }), clearTimeout() {},
  });
  coalescer.push({ schemaVersion: 1, eventID: "synthetic-global", runID: "global", platform: "opencode", sessionHMAC: "1".repeat(64), eventType: "FileEdit", timestamp: "2026-08-24T12:00:00.000Z", dedupeKey: "synthetic-global" });
  await coalescer.dispose();
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].summary, legacy.summary[0].summary);
  for (const field of ["runID", "sessionHMAC", "eventID", "dedupeKey"]) {
    assert.notEqual(events[0][field], legacy.summary[0][field]);
  }
});
