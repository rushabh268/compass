import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openDatabase, readTransaction } from "../../src/state/database.mjs";
import { openLedger } from "../../src/state/ledger.mjs";

const key = Buffer.alloc(32, 0xa5);

test("readTransaction keeps WAL reads on one snapshot", async (t) => {
  const root = await mkdir(
    join(tmpdir(), `agent-harness-read-transaction-${process.pid}-${Date.now()}`),
    { recursive: true },
  );
  const path = join(root, "ledger.sqlite");
  const writer = openLedger({ path, hmacKey: key });
  writer.createRun("run-1");
  const reader = openDatabase(path);
  t.after(() => reader.close());
  t.after(() => writer.close());

  const [before, after] = readTransaction(reader, () => {
    const initial = reader.prepare(
      "SELECT event_count, head_hmac FROM runs WHERE run_id = ?",
    ).get("run-1");
    writer.append({
      schemaVersion: 1,
      eventID: "event-1",
      runID: "run-1",
      platform: "opencode",
      sessionHMAC: "3".repeat(64),
      eventType: "PreToolUse",
      timestamp: "2026-08-24T12:34:56.000Z",
      dedupeKey: "run-1:call-1",
    });
    const repeated = reader.prepare(
      "SELECT event_count, head_hmac FROM runs WHERE run_id = ?",
    ).get("run-1");
    return [initial, repeated];
  });

  assert.deepEqual(after, before);
  assert.equal(before.event_count, 0);
  assert.equal(
    reader.prepare("SELECT event_count FROM runs WHERE run_id = ?").get("run-1").event_count,
    1,
  );
});
