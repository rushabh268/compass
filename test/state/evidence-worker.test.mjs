import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile, stat, symlink, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createEvidenceService } from "../../src/evidence/service.mjs";
import { openLedger } from "../../src/state/ledger.mjs";
import { openReadDatabase } from "../../src/state/database.mjs";
import { translateClaudeHook } from "../../adapters/claude/translate.mjs";
import { translateCodexHook } from "../../adapters/codex/translate.mjs";
import { translateOpenCodeEvent } from "../../adapters/opencode/translate.mjs";
import { buildGroundingEvent } from "../../src/grounding-event.mjs";
const key = Buffer.alloc(32, 7);
const selector = (platform, rootSessionID = "synthetic-root", subject) => ({
  version: 1,
  platform,
  rootSessionID,
  ...(subject ? { subject } : {}),
});
const metadata = {
  sources: [],
  bytes: 0,
  approxTokens: 0,
  matchReason: "none",
  commentFiles: 0,
  latencyMs: 0,
};
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "compass-worker-")),
    path = join(root, "ledger.db"),
    ledger = openLedger({ path, hmacKey: key });
  const service = createEvidenceService({ path, key, ...options });
  t.after(async () => {
    await service.close();
    ledger.close();
    await rm(root, { recursive: true, force: true });
  });
  const add = (event) => {
    ledger.ensureRun(event.runID);
    ledger.append(event);
    return event;
  };
  return { root, path, ledger, service, add };
}
for (const platform of ["claude", "codex", "opencode"])
  test(`${platform} root/child and targeted monthly grounding remain separate`, async (t) => {
    const f = await fixture(t);
    if (platform === "opencode") {
      f.add(
        translateOpenCodeEvent(
          {
            type: "session.created",
            properties: { info: { id: "synthetic-root" } },
          },
          { authKey: key, occurrenceID: "root" },
        ),
      );
      f.add(
        translateOpenCodeEvent(
          {
            type: "session.created",
            properties: {
              info: { id: "synthetic-child", parentID: "synthetic-root" },
            },
          },
          { authKey: key, occurrenceID: "child" },
        ),
      );
    } else {
      const translate =
        platform === "claude" ? translateClaudeHook : translateCodexHook;
      f.add(
        translate(
          { session_id: "synthetic-root", hook_event_name: "SessionStart" },
          { authKey: key, occurrenceID: "root" },
        ),
      );
      f.add(
        translate(
          {
            session_id: "synthetic-root",
            agent_id: "synthetic-child",
            hook_event_name: "SubagentStart",
          },
          { authKey: key, occurrenceID: "child" },
        ),
      );
    }
    const subject = {
      kind: platform === "opencode" ? "session" : "agent",
      nativeID: "synthetic-child",
    };
    f.add(
      buildGroundingEvent(metadata, {
        platform,
        hmacKey: key,
        occurrenceID: "target",
        target: subject,
      }),
    );
    f.add(
      buildGroundingEvent(metadata, {
        platform,
        hmacKey: key,
        occurrenceID: "legacy",
      }),
    );
    f.add(
      buildGroundingEvent(metadata, {
        platform,
        hmacKey: key,
        occurrenceID: "root",
        target: { kind: "root", nativeID: "synthetic-root" },
      }),
    );
    const child = await f.service.begin(
      selector(platform, "synthetic-root", subject),
    );
    assert.equal(child.state, "ready");
    assert.equal(child.relationship, "direct");
    assert.deepEqual(child.summary, { events: 1, grounding: 1 });
    const root = await f.service.begin(selector(platform));
    assert.deepEqual(root.summary, { events: 1, grounding: 1 });
    const wrong = await f.service.begin(
      selector(platform, "wrong-root", subject),
    );
    assert.equal(
      platform === "opencode" ? wrong.relationship : wrong.state,
      platform === "opencode" ? "unknown" : "unavailable",
    );
    assert.equal(JSON.stringify(child).includes("synthetic-child"), false);
  });
test("OpenCode missing and nested immediate parents stay unknown", async (t) => {
  const f = await fixture(t);
  for (const [id, parentID] of [
    ["nested", "middle"],
    ["orphan", undefined],
  ]) {
    f.add(
      translateOpenCodeEvent(
        {
          type: "session.created",
          properties: { info: { id, ...(parentID ? { parentID } : {}) } },
        },
        { authKey: key, occurrenceID: id },
      ),
    );
    const result = await f.service.begin(
      selector("opencode", "synthetic-root", { kind: "session", nativeID: id }),
    );
    assert.equal(result.relationship, "unknown");
    assert.equal(result.summary.events, 1);
  }
});
test("read opener does not create, migrate, chmod, or accept symlinks", async (t) => {
  const f = await fixture(t),
    before = await readFile(f.path),
    mode = (await stat(f.path)).mode;
  const db = openReadDatabase(f.path);
  assert.throws(() =>
    db.exec("INSERT INTO runs(run_id,state) VALUES('x','CREATED')"),
  );
  db.close();
  assert.deepEqual(await readFile(f.path), before);
  assert.equal((await stat(f.path)).mode, mode);
  assert.throws(() => openReadDatabase(join(f.root, "missing")));
  await symlink(f.path, join(f.root, "alias"));
  assert.throws(() => openReadDatabase(join(f.root, "alias")));
  await chmod(f.path, 0o644);
  assert.throws(() => openReadDatabase(f.path));
  await chmod(f.path, 0o600);
});
for (const mutation of [
  "UPDATE events SET body=replace(body,'SessionStart','SessionEnd')",
  "UPDATE events SET previous_hmac='wrong'",
  "UPDATE runs SET activity_hmac=''",
  "UPDATE runs SET event_count=0",
  "UPDATE runs SET head_hmac=''",
  "UPDATE runs SET commitment=''",
  "DELETE FROM events",
])
  test(`evidence fails closed on ${mutation}`, async (t) => {
    const f = await fixture(t);
    f.add(
      translateClaudeHook(
        { session_id: "synthetic-root", hook_event_name: "SessionStart" },
        { authKey: key },
      ),
    );
    const db = new DatabaseSync(f.path);
    db.exec(mutation);
    db.close();
    assert.equal(
      (await f.service.begin(selector("claude"))).state,
      "unavailable",
    );
  });
test("monthly candidate integrity is checked before target filtering", async (t) => {
  const f = await fixture(t);
  f.add(
    translateClaudeHook(
      { session_id: "synthetic-root", hook_event_name: "SessionStart" },
      { authKey: key },
    ),
  );
  const other = f.add(
    buildGroundingEvent(metadata, {
      platform: "claude",
      hmacKey: key,
      target: { kind: "root", nativeID: "other" },
    }),
  );
  const db = new DatabaseSync(f.path);
  db.prepare("UPDATE events SET hmac='bad' WHERE run_id=?").run(other.runID);
  db.close();
  assert.equal(
    (await f.service.begin(selector("claude"))).state,
    "unavailable",
  );
});
test("queue pressure, worker crash, timeout and shutdown never fall back to synchronous ledger reads", async (t) => {
  const f = await fixture(t, { maxJobs: 1 });
  const first = f.service.begin(selector("claude"));
  assert.equal(
    (await f.service.begin(selector("claude"))).state,
    "resource_exhausted",
  );
  await first;
  const crash = createEvidenceService({
    path: f.path,
    key,
    workerURL: new URL(
      'data:text/javascript,throw new Error("synthetic crash")',
    ),
  });
  assert.equal((await crash.begin(selector("claude"))).state, "unavailable");
  await crash.close();
  const timeout = createEvidenceService({
    path: f.path,
    key,
    timeout: 20,
    workerURL: new URL("data:text/javascript,setInterval(()=>{},1000)"),
  });
  assert.equal((await timeout.begin(selector("claude"))).state, "unavailable");
  await timeout.close();
  const closing = f.service.begin(selector("claude"));
  await f.service.close();
  assert.equal((await closing).state, "unavailable");
});
test("cache eviction invalidates cursors instead of mixing snapshots", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 55; i++)
    f.add(
      translateClaudeHook(
        { session_id: "synthetic-root", hook_event_name: "SessionStart" },
        { authKey: key, occurrenceID: String(i) },
      ),
    );
  const first = await f.service.begin(selector("claude"));
  for (let i = 0; i < 8; i++) await f.service.begin(selector("claude"));
  assert.equal(
    (await f.service.continue({ version: 1, cursor: first.nextCursor })).state,
    "stale",
  );
});

test("20,000-event verification runs off writer and concurrent appends preserve immutable pages", async (t) => {
  const f = await fixture(t);
  const event = (i) =>
    translateClaudeHook(
      { session_id: "synthetic-root", hook_event_name: "SessionStart" },
      { authKey: key, occurrenceID: String(i) },
    );
  f.ledger.ensureRun(event(0).runID);
  for (let i = 0; i < 20000; i++) f.ledger.append(event(i));
  let completed = false;
  const pending = f.service.begin(selector("claude")).then((value) => {
    completed = true;
    return value;
  });
  const start = performance.now();
  for (let i = 20000; i < 20010; i++) f.ledger.append(event(i));
  const appendMs = performance.now() - start;
  assert.equal(
    completed,
    false,
    "worker read must not synchronously finish on writer",
  );
  const first = await pending;
  assert.equal(first.state, "ready");
  assert.ok(first.eventCount >= 20000 && first.eventCount <= 20010);
  const second = await f.service.continue({
    version: 1,
    cursor: first.nextCursor,
  });
  assert.equal(second.head, first.head);
  assert.equal(second.eventCount, first.eventCount);
  t.diagnostic(
    JSON.stringify({ events: 20000, concurrentAppends: 10, appendMs }),
  );
});
test("pruning cannot blend a cached page with current history; monthly receipt is not session proof", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 55; i++)
    f.add(
      translateClaudeHook(
        { session_id: "synthetic-root", hook_event_name: "SessionStart" },
        { authKey: key, occurrenceID: String(i) },
      ),
    );
  f.add(
    buildGroundingEvent(metadata, {
      platform: "claude",
      hmacKey: key,
      target: { kind: "root", nativeID: "synthetic-root" },
    }),
  );
  const first = await f.service.begin(selector("claude"));
  assert.equal(first.state, "ready");
  f.ledger.pruneRuns({
    olderThanUnix: Math.floor(Date.now() / 1000) + 400 * 86400,
    nowUnix: Math.floor(Date.now() / 1000) + 400 * 86400,
    maxRuns: 100,
  });
  const second = await f.service.continue({
    version: 1,
    cursor: first.nextCursor,
  });
  assert.equal(second.state, "ready");
  assert.equal(second.snapshotID, first.snapshotID);
  const fresh = await f.service.begin(selector("claude"));
  assert.equal(fresh.state, "pruned");
  assert.equal(fresh.groundingState, "unavailable");
  const unrelated = await f.service.begin(selector("claude", "unrelated"));
  assert.equal(unrelated.state, "absent");
  assert.equal(unrelated.groundingState, "unavailable");
  const db = new DatabaseSync(f.path);
  db.exec("UPDATE run_archive SET archive_hmac='bad'");
  db.close();
  assert.equal(
    (await f.service.begin(selector("claude"))).state,
    "unavailable",
  );
});
test("expired snapshot cursors become stale even without an append", async (t) => {
  const f = await fixture(t, { snapshotTTL: 30 });
  for (let i = 0; i < 55; i++)
    f.add(
      translateClaudeHook(
        { session_id: "synthetic-root", hook_event_name: "SessionStart" },
        { authKey: key, occurrenceID: String(i) },
      ),
    );
  const first = await f.service.begin(selector("claude"));
  while (Date.now() <= first.expiresAt)
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(1, first.expiresAt - Date.now() + 1)),
    );
  assert.equal(
    (await f.service.continue({ version: 1, cursor: first.nextCursor })).state,
    "stale",
  );
});
test("reader retention uses verified worker aggregates and enforces finite event budget", async (t) => {
  const f = await fixture(t);
  f.add(
    translateClaudeHook(
      { session_id: "synthetic-root", hook_event_name: "SessionStart" },
      { authKey: key },
    ),
  );
  assert.deepEqual(
    await f.service.retentionStatus(),
    f.ledger.retentionStatus(),
  );
  const db = new DatabaseSync(f.path);
  db.exec("UPDATE runs SET event_count=50001");
  db.close();
  assert.equal(
    (await f.service.begin(selector("claude"))).state,
    "resource_exhausted",
  );
});
