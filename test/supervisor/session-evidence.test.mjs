import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedger } from "../../src/state/ledger.mjs";
import { startSupervisor } from "../../src/supervisor/server.mjs";
import { request } from "../../src/supervisor/client.mjs";
import { translateClaudeHook } from "../../adapters/claude/translate.mjs";
test("evidence pages freeze a verified run while concurrent appends continue", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "compass-evidence-")),
    path = join(root, "ledger.db"),
    socketPath = join(root, "rpc");
  const authKey = Buffer.alloc(32, 1),
    readerKey = Buffer.alloc(32, 2),
    ledger = openLedger({ path, hmacKey: authKey });
  const event = (i) =>
    translateClaudeHook(
      { session_id: "synthetic-root", hook_event_name: "SessionStart" },
      { authKey, occurrenceID: String(i) },
    );
  ledger.ensureRun(event(0).runID);
  for (let i = 0; i < 60; i++) ledger.append(event(i));
  const server = await startSupervisor({
    socketPath,
    authKey,
    readerKey,
    ledger,
    ledgerPath: path,
  });
  t.after(async () => {
    await server.close();
    ledger.close();
    await rm(root, { recursive: true, force: true });
  });
  const call = (method, params) =>
    request({ socketPath, authKey: readerKey, method, params, timeout: 10000 });
  const first = await call("beginSessionEvidence", {
    version: 1,
    platform: "claude",
    rootSessionID: "synthetic-root",
  });
  assert.equal(first.state, "ready");
  assert.equal(first.events.length, 50);
  assert.equal(first.eventCount, 60);
  ledger.append(event(61));
  const second = await call("continueSessionEvidence", {
    version: 1,
    cursor: first.nextCursor,
  });
  assert.equal(second.snapshotID, first.snapshotID);
  assert.equal(second.events.length, 10);
  assert.equal(second.nextCursor, null);
  assert.equal(JSON.stringify(first).includes("synthetic-root"), false);
  assert.equal(
    (
      await call("continueSessionEvidence", {
        version: 1,
        cursor: first.nextCursor + "x",
      })
    ).state,
    "stale",
  );
});
