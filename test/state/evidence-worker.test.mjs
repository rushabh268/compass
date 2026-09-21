import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter, once } from "node:events";
import { Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { mkdtemp, rm, readFile, stat, symlink, chmod, writeFile } from "node:fs/promises";
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

for (const failure of ["timeout", "crash", "exit"]) {
  test(`failed worker generation recovers after ${failure} without replay`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "compass-recovery-"));
    const workerPath = join(root, "worker.mjs");
    const failing = failure === "timeout" ? "setInterval(() => {}, 1000)"
      : failure === "crash" ? 'throw new Error("synthetic failure")' : "process.exit(0)";
    await writeFile(workerPath, failing);
    const service = createEvidenceService({ key, timeout: 300, workerURL: pathToFileURL(workerPath) });
    t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
    const first = service.begin(selector("claude"));
    const queued = service.retentionStatus();
    assert.equal((await first).state, "unavailable");
    assert.equal((await queued).state, "unavailable");
    await writeFile(workerPath, `import { parentPort } from "node:worker_threads";
      parentPort.on("message", ({id}) => parentPort.postMessage({id, result: {version:1, state:"absent"}}));`);
    assert.deepEqual(await service.begin(selector("claude")), { version: 1, state: "absent" });
  });
}

function controlledWorkers(options = {}) {
  const workers = [];
  const service = createEvidenceService({ key, timeout: 100, ...options,
    workerFactory() {
      const worker = new EventEmitter();
      worker.sent = [];
      worker.postMessage = (job) => worker.sent.push(job);
      worker.terminate = () => { worker.terminated = true; return Promise.resolve(0); };
      workers.push(worker);
      return worker;
    },
  });
  return { service, workers };
}

test("queued jobs receive their own dispatch watchdog and admission stays bounded", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { service, workers } = controlledWorkers({ maxJobs: 2 });
  t.after(() => service.close());
  const first = service.begin(selector("claude"));
  const second = service.retentionStatus();
  assert.equal((await service.retentionStatus()).state, "resource_exhausted");
  const worker = workers[0];
  assert.equal(worker.sent.length, 1);
  t.mock.timers.tick(90);
  worker.emit("message", { id: worker.sent[0].id, result: { version: 1, state: "absent" } });
  assert.equal((await first).state, "absent");
  assert.equal(worker.sent.length, 2);
  t.mock.timers.tick(90);
  assert.equal(worker.terminated, undefined);
  worker.emit("message", { id: worker.sent[1].id, result: { version: 1, state: "absent" } });
  assert.equal((await second).state, "absent");
});

test("obsolete events cannot settle replacement jobs and close awaits every termination", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { service, workers } = controlledWorkers();
  t.after(() => service.close());
  const first = service.begin(selector("claude"));
  const old = workers[0];
  let releaseOld;
  old.terminate = () => new Promise(resolve => { releaseOld = resolve; });
  t.mock.timers.tick(100);
  assert.equal((await first).state, "unavailable");
  const replacement = service.begin(selector("claude"));
  const current = workers[1];
  old.emit("exit", 1);
  old.emit("error", new Error("late failure"));
  old.emit("message", { id: current.sent[0].id, result: { version: 1, state: "absent" } });
  let settled = false;
  replacement.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  let closed = false;
  const closing = service.close().then(() => { closed = true; });
  const repeated = service.close();
  assert.equal((await replacement).state, "unavailable");
  assert.equal((await service.begin(selector("claude"))).state, "unavailable");
  await Promise.resolve();
  assert.equal(closed, false);
  assert.equal(workers.length, 2);
  releaseOld(0);
  await Promise.all([closing, repeated]);
  assert.equal(current.terminated, true);
});

test("constructor and dispatch errors settle jobs and allow later recovery", async (t) => {
  let attempts = 0;
  const workers = [];
  const service = createEvidenceService({ key, workerFactory() {
    attempts += 1;
    if (attempts === 1) throw new Error("constructor failed");
    const worker = new EventEmitter();
    worker.terminate = () => Promise.resolve(0);
    worker.postMessage = (job) => {
      if (attempts === 2) throw new Error("dispatch failed");
      queueMicrotask(() => worker.emit("message", { id: job.id, result: { version: 1, state: "absent" } }));
    };
    workers.push(worker);
    return worker;
  } });
  t.after(() => service.close());
  assert.equal((await service.begin(selector("claude"))).state, "unavailable");
  assert.equal((await service.retentionStatus()).state, "unavailable");
  assert.equal((await service.begin(selector("claude"))).state, "absent");
  await service.close();
  assert.equal((await service.retentionStatus()).state, "unavailable");
  assert.equal(attempts, 3);
});

test("real worker replacement rejects old snapshot cursors as stale", async (t) => {
  const workers = [];
  const f = await fixture(t, { workerFactory(url, options) {
    const worker = new Worker(url, options); workers.push(worker); return worker;
  } });
  for (let i = 0; i < 55; i++) f.add(translateClaudeHook(
    { session_id: "synthetic-root", hook_event_name: "SessionStart" },
    { authKey: key, occurrenceID: String(i) },
  ));
  const first = await f.service.begin(selector("claude"));
  assert.equal(first.state, "ready");
  assert.ok(first.nextCursor);
  const exited = once(workers[0], "exit");
  await workers[0].terminate(); await exited;
  assert.equal((await f.service.continue({ version: 1, cursor: first.nextCursor })).state, "stale");
  assert.equal((await f.service.begin(selector("claude"))).state, "ready");
});
