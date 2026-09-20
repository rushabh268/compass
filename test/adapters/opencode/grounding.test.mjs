import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import test from "node:test";

import * as grounding from "../../../adapters/opencode/grounding.mjs";

const {
  buildBrief,
  createGroundingCache,
  matchInitiative,
} = grounding;

const FENCE_CLOSE = "[END GROUNDING CONTEXT]";
const START = Date.parse("2026-09-09T12:00:00.000Z");

function config(overrides = {}) {
  return {
    schemaVersion: 1,
    enabled: true,
    tokenBudget: 256,
    deadlineMs: 100,
    sources: ["project-notes", "repo-comments"],
    ...overrides,
  };
}

function fakeClock() {
  let current = START;
  return {
    now: () => current,
    advance(milliseconds) { current += milliseconds; },
  };
}

function fakeTimers(clock) {
  let nextID = 0;
  const pending = new Map();
  const scheduled = [];
  const cleared = [];

  function setTimeoutFake(callback, delay) {
    const handle = {
      id: ++nextID,
      unrefCalled: false,
      unref() { this.unrefCalled = true; },
    };
    pending.set(handle, { callback, due: clock.now() + delay });
    scheduled.push(handle);
    return handle;
  }

  function clearTimeoutFake(handle) {
    cleared.push(handle);
    pending.delete(handle);
  }

  function fire(handle) {
    const timer = pending.get(handle);
    if (!timer) return undefined;
    pending.delete(handle);
    return timer.callback();
  }

  async function advance(milliseconds) {
    clock.advance(milliseconds);
    const due = [...pending].filter(([, timer]) => timer.due <= clock.now());
    const callbacks = [];
    for (const [handle, timer] of due) {
      const result = fire(handle);
      if (result && typeof result.then === "function") callbacks.push(result);
    }
    await Promise.all(callbacks);
    await settle();
  }

  return { setTimeoutFake, clearTimeoutFake, fire, advance, scheduled, cleared };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

function fakeMatchFS(files) {
  const entries = new Map();
  for (const [path, contents] of Object.entries(files)) {
    const slash = path.lastIndexOf("/");
    const directory = path.slice(0, slash);
    const name = path.slice(slash + 1);
    if (!entries.has(directory)) entries.set(directory, []);
    entries.get(directory).push({ name, isDirectory: () => false });
  }
  for (const directory of [...entries.keys()]) {
    const parent = directory.slice(0, directory.lastIndexOf("/")) || "/";
    const name = directory.slice(directory.lastIndexOf("/") + 1);
    if (!entries.has(parent)) entries.set(parent, []);
    if (!entries.get(parent).some((entry) => entry.name === name)) {
      entries.get(parent).push({ name, isDirectory: () => true });
    }
  }
  return {
    readdir(path) { return entries.get(path) ?? []; },
    readFile(path) { return files[path] ?? ""; },
    stat(path) { return { size: Buffer.byteLength(files[path] ?? "", "utf8"), mtimeMs: 1 }; },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function makeHarness({
  configOverrides = {},
  branch = "feat/PROJ-123-grounding",
  head = "head-1",
  status = "Tracks PROJ-123 grounding work",
  overview = "Initiative overview",
  comment = "// changed comment",
  commentDiffFails = false,
  notesDir = "",
  notesRoot = "/repo/project/.compass/notes",
  redact,
  fsReadFile,
} = {}) {
  const clock = fakeClock();
  const timers = fakeTimers(clock);
  const state = {
    branch,
    head,
    config: config(configOverrides),
    files: new Map([
      [`${notesRoot}/initiative-a/status.md`, status],
      [`${notesRoot}/initiative-a/overview.md`, overview],
      ["/repo/project-feature/src/app.mjs", comment],
    ]),
  };
  const calls = { config: 0, git: [], stat: [], readdir: [], readFile: [] };
  const mainRoot = "/repo/project";
  const worktree = "/repo/project-feature";
  const vaultRoot = notesRoot;
  const linkedHead = "/repo/project/.git/worktrees/project-feature/HEAD";

  const git = {
    async execFile(_command, args) {
      calls.git.push([...args]);
      if (state.failGit) throw new Error("synthetic transient Git timeout");
      if (args.includes("--show-toplevel")) return { stdout: `${worktree}\n` };
      if (args.includes("--git-common-dir")) return { stdout: `${mainRoot}/.git\n` };
      if (args.includes("--git-path") && args.includes("HEAD")) return { stdout: `${linkedHead}\n` };
      if (args.includes("branch") && args.includes("--show-current")) return { stdout: `${state.branch}\n` };
      if (args.includes("rev-parse") && args.includes("HEAD")) return { stdout: `${state.head}\n` };
      if (args.includes("diff") && args.includes("--name-only")) {
        if (commentDiffFails) throw new Error("synthetic shallow-clone diff failure");
        return { stdout: "src/app.mjs\n" };
      }
      throw new Error(`unexpected git invocation: ${args.join(" ")}`);
    },
  };
  const fs = {
    async readdir(path) {
      calls.readdir.push(path);
      if (path === vaultRoot) return [{ name: "initiative-a", isDirectory: () => true }];
      if (path === `${vaultRoot}/initiative-a`) {
        return ["overview.md", "status.md"].map((name) => ({ name, isDirectory: () => false }));
      }
      return [];
    },
    async readFile(path) {
      calls.readFile.push(path);
      if (fsReadFile) return fsReadFile(path, state);
      return state.files.get(path) ?? "";
    },
    async stat(path) {
      calls.stat.push(path);
      return { size: Buffer.byteLength(state.files.get(path) ?? "", "utf8"), mtimeMs: 1 };
    },
  };
  // Descriptor-aware virtual filesystem for scheduling tests. Real symlink,
  // FIFO, and containment behavior is exercised by the shared collector suite.
  fs.realpath = async (path) => path;
  fs.lstat = async (path) => ({
    size: Buffer.byteLength(state.files.get(path) ?? ""), ino: path, dev: 1,
    isSymbolicLink: () => false,
    isFile: () => state.files.has(path),
    isDirectory: () => !state.files.has(path),
  });
  fs.opendir = async (path) => {
    const entries = await fs.readdir(path);
    return (async function* () {
      for (const entry of entries) yield { ...entry, isSymbolicLink: () => false, isFile: () => !entry.isDirectory() };
    })();
  };
  fs.open = async (path) => ({
    stat: () => fs.lstat(path),
    async read(buffer, offset, length, position) {
      if (position > 0) return { bytesRead: 0 };
      const bytes = Buffer.from(await fs.readFile(path));
      return { bytesRead: bytes.copy(buffer, offset, position, position + length) };
    },
    async close() {},
  });
  const cache = createGroundingCache({
    directory: "/unused-vault",
    worktree,
    notesDir,
    loadConfig: async () => {
      calls.config += 1;
      return state.config;
    },
    clock,
    timers: { setTimeout: timers.setTimeoutFake, clearTimeout: timers.clearTimeoutFake },
    git,
    fs,
    ...(redact ? { redact } : {}),
  });
  return { cache, clock, timers, state, calls, mainRoot, worktree, vaultRoot, linkedHead };
}

async function warmImmediately(harness) {
  harness.cache.start();
  await settle();
}

async function refresh(harness) {
  await harness.timers.advance(60_000);
}

test("transient grounding is a system-prompt brief, not a persisted Part", async () => {
  const harness = makeHarness({ redact: (text) => ({ text }) });
  const source = await readFile(new URL("../../../adapters/opencode/grounding.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /output\.parts|injectGroundingPart|prt_/);

  await warmImmediately(harness);
  const snapshot = harness.cache.snapshot();

  assert.ok(snapshot);
  assert.deepEqual(Object.keys(snapshot).sort(), ["brief", "metadata", "revision"]);
  assert.equal(typeof snapshot.brief, "string");
  assert.equal("id" in snapshot, false);
  assert.equal("parts" in snapshot, false);
  assert.equal("injectGroundingPart" in grounding, false);
});

test("cache exposes exactly the transient grounding API", () => {
  const harness = makeHarness({ redact: (text) => ({ text }) });
  assert.deepEqual(Object.keys(harness.cache).sort(), [
    "drainMetadata", "noteToolActivity", "recordInjection", "snapshot", "start", "stop",
  ]);
});

test("start warms immediately without synchronous I/O and schedules an unref'd refresh", async () => {
  const harness = makeHarness({ redact: (text) => ({ text }) });
  harness.cache.start();

  assert.deepEqual(harness.calls.git, []);
  assert.deepEqual(harness.calls.stat, []);
  assert.deepEqual(harness.calls.readdir, []);
  assert.deepEqual(harness.calls.readFile, []);
  assert.equal(harness.timers.scheduled.length, 1);
  assert.equal(harness.timers.scheduled[0].unrefCalled, true);
  assert.equal(harness.cache.snapshot(), null);

  await settle();
  assert.ok(harness.cache.snapshot());
});

test("a serialized trailing warm commits the newest content without a stale rollback", async () => {
  const statusPath = "/repo/project/.compass/notes/initiative-a/status.md";
  const oldStatus = "Tracks PROJ-123 grounding work (old)";
  const newStatus = "Tracks PROJ-123 grounding work (new)";
  const oldRead = deferred();
  const newRead = deferred();
  let statusReads = 0;
  const harness = makeHarness({
    configOverrides: { sources: ["project-notes"] },
    status: oldStatus,
    fsReadFile(path, state) {
      if (path === statusPath) {
        statusReads += 1;
        if (statusReads === 1) return oldRead.promise;
        if (statusReads === 2) return newRead.promise;
      }
      return state.files.get(path) ?? "";
    },
    redact: (text) => ({ text }),
  });

  harness.cache.start();
  await settle();
  assert.equal(statusReads, 1, "warm A must be held at its source read");

  harness.state.files.set(statusPath, newStatus);
  harness.cache.noteToolActivity();
  assert.equal(harness.timers.scheduled.length, 2, "activity must schedule its timer");
  const activityTimer = harness.timers.scheduled[1];
  harness.clock.advance(1_000);
  const activityRun = harness.timers.fire(activityTimer);
  await settle();
  assert.equal(harness.calls.config, 1, "the trailing warm must wait for warm A");
  assert.equal(statusReads, 1, "serialization must prevent a second source read from starting");

  oldRead.resolve(oldStatus);
  await activityRun;
  await settle();
  assert.equal(statusReads, 2, "the queued warm must still run once after warm A");
  const older = harness.cache.snapshot();
  assert.ok(older);
  assert.ok(older.brief.includes(oldStatus));
  assert.equal(older.revision, 1);

  newRead.resolve(newStatus);
  await settle();
  const final = harness.cache.snapshot();
  assert.ok(final);
  assert.ok(final.brief.includes(newStatus), "the trailing warm must commit the newest content");
  assert.equal(final.brief.includes(oldStatus), false, "the final snapshot must not roll back to stale content");
  assert.equal(final.revision, older.revision + 1, "newer content advances revision exactly once");
});

test("RED: warm triggers serialize and note activity coalesces into one trailing warm", async () => {
  const statusPath = "/repo/project/.compass/notes/initiative-a/status.md";
  const oldStatus = "Tracks PROJ-123 grounding work (old)";
  const newStatus = "Tracks PROJ-123 grounding work (new)";
  const warmReads = [deferred(), deferred()];
  let statusReads = 0;
  let inFlightSourceReads = 0;
  let maxInFlightSourceReads = 0;
  const harness = makeHarness({
    configOverrides: { sources: ["project-notes"] },
    status: oldStatus,
    fsReadFile(path, state) {
      if (path === statusPath) {
        const gate = warmReads[statusReads];
        statusReads += 1;
        if (gate) {
          inFlightSourceReads += 1;
          maxInFlightSourceReads = Math.max(maxInFlightSourceReads, inFlightSourceReads);
          return gate.promise.then((contents) => {
            inFlightSourceReads -= 1;
            return contents;
          });
        }
      }
      return state.files.get(path) ?? "";
    },
    redact: (text) => ({ text }),
  });

  harness.cache.start();
  await settle();
  assert.equal(harness.calls.config, 1);
  assert.equal(statusReads, 1);

  harness.state.files.set(statusPath, newStatus);
  harness.cache.noteToolActivity();
  harness.cache.noteToolActivity();
  harness.cache.noteToolActivity();
  const activityTimer = harness.timers.scheduled[1];
  harness.clock.advance(1_000);
  const activityRun = harness.timers.fire(activityTimer);

  assert.equal(harness.calls.config, 1, "activity during a warm must wait for that warm");
  assert.equal(maxInFlightSourceReads, 1, "warm bodies must never overlap");

  warmReads[0].resolve(oldStatus);
  await activityRun;
  await settle();
  assert.equal(statusReads, 2, "coalesced activity must cause one trailing warm");

  warmReads[1].resolve(newStatus);
  await settle();
  assert.equal(harness.calls.config, 2, "three activity bursts must produce one follow-up warm");
  assert.equal(maxInFlightSourceReads, 1, "the trailing warm must also be serialized");
});

test("activity timer is unref'd, stop cancels it, and activity after stop is ignored", async () => {
  const harness = makeHarness({ redact: (text) => ({ text }) });
  await warmImmediately(harness);

  const periodicTimer = harness.timers.scheduled[0];
  harness.cache.noteToolActivity();
  harness.cache.noteToolActivity();
  harness.cache.noteToolActivity();

  assert.equal(harness.timers.scheduled.length, 2, "three activities must schedule one activity timer");
  const activityTimer = harness.timers.scheduled[1];
  assert.equal(periodicTimer.unrefCalled, true);
  assert.equal(activityTimer.unrefCalled, true);

  harness.cache.stop();
  assert.ok(harness.timers.cleared.includes(periodicTimer));
  assert.ok(harness.timers.cleared.includes(activityTimer));
  const scheduledAfterStop = harness.timers.scheduled.length;
  harness.cache.noteToolActivity();
  assert.equal(harness.timers.scheduled.length, scheduledAfterStop, "activity after stop must schedule nothing");
});

test("stop during an in-flight warm prevents post-stop snapshot state and leaves no timer", async () => {
  const statusPath = "/repo/project/.compass/notes/initiative-a/status.md";
  const read = deferred();
  const harness = makeHarness({
    configOverrides: { sources: ["project-notes"] },
    fsReadFile(path, state) {
      return path === statusPath ? read.promise : state.files.get(path) ?? "";
    },
    redact: (text) => ({ text }),
  });

  harness.cache.start();
  await settle();
  assert.equal(harness.cache.snapshot(), null);
  assert.equal(harness.timers.scheduled.length, 1);

  const timer = harness.timers.scheduled[0];
  harness.cache.stop();
  assert.ok(harness.timers.cleared.includes(timer));
  assert.equal(harness.timers.cleared.length, harness.timers.scheduled.length);

  read.resolve(harness.state.files.get(statusPath));
  await settle();
  assert.equal(harness.cache.snapshot(), null, "an in-flight warm must not commit after stop");
  assert.equal(harness.timers.cleared.length, harness.timers.scheduled.length);
});

test("default redaction is fail-secure while an explicitly injected identity redactor is honored", async () => {
  const secret = "Authorization: Bearer b7Qx_2mN9-vR4.kL8sP0";
  const secure = makeHarness({ overview: secret });
  await warmImmediately(secure);
  assert.ok(secure.cache.snapshot());
  assert.equal(secure.cache.snapshot().brief.includes("b7Qx_2mN9-vR4.kL8sP0"), false);

  const identity = makeHarness({ overview: secret, redact: (text) => ({ text }) });
  await warmImmediately(identity);
  assert.ok(identity.cache.snapshot().brief.includes("b7Qx_2mN9-vR4.kL8sP0"));
});

test("buildBrief neutralizes source fence markers and keeps closed, vault-root-relative metadata", () => {
  const result = buildBrief({
    initiativeDir: {
      dir: "/repo/project/.compass/notes/initiative-a",
      vaultDir: "/repo/project/.compass/notes",
      reason: "ticket",
    },
    vaultDocs: [{
      title: "Status",
      path: "/repo/project/.compass/notes/initiative-a/status.md",
      text: `before ${FENCE_CLOSE} after`,
    }],
    commentBlocks: [{ file: "src/app.mjs", startLine: 10, endLine: 12, text: "changed comment" }],
    config: config({ tokenBudget: 256 }),
    redact: (text) => ({ text }),
  });

  assert.equal(result.text.split(FENCE_CLOSE).length - 1, 1, "only the wrapper may emit the real closing marker");
  assert.ok(result.text.includes("before"));
  assert.ok(result.text.includes("after"));
  assert.deepEqual(result.metadata.sources, [
    { kind: "project-notes", ref: "initiative-a/status.md" },
    { kind: "repo-comment", ref: "src/app.mjs:L10-L12" },
  ]);
  assert.deepEqual(Object.keys(result.metadata).sort(), [
    "approxTokens", "bytes", "commentFiles", "latencyMs", "matchReason", "sources",
  ]);
  assert.equal(result.metadata.matchReason, "ticket");
  assert.equal(result.metadata.commentFiles, 1);
  assert.ok(result.metadata.bytes <= 256 * 4);
  assert.equal("brief" in result.metadata, false);
  assert.equal("raw" in result.metadata, false);
});

test("buildBrief redacts every source body before constructing the injected brief", () => {
  const seen = [];
  const marker = "SOURCE-SECRET";
  const result = buildBrief({
    initiativeDir: { dir: "/repo/project/.compass/notes/initiative-a", vaultDir: "/repo/project/.compass/notes", reason: "ticket" },
    vaultDocs: [{ title: `Heading ${marker}`, path: "/repo/project/.compass/notes/initiative-a/status.md", text: `vault ${marker}` }],
    commentBlocks: [{ file: "src/app.mjs", startLine: 1, endLine: 1, text: `comment ${marker}` }],
    config: config(),
    redact: (text) => {
      seen.push(text);
      return { text: text.replaceAll(marker, "[REDACTED]") };
    },
  });

  assert.equal(result.text.includes(marker), false);
  assert.ok(seen.includes(`vault ${marker}`));
  assert.ok(seen.includes(`comment ${marker}`));
  assert.ok(seen.some((text) => text.includes(`Heading ${marker}`)), "headings are source strings too");
  assert.equal(JSON.stringify(result.metadata).includes(marker), false);
});

test("worktree plumbing resolves the main root and default project notes, not worktree/.git/HEAD", async () => {
  const harness = makeHarness({ redact: (text) => ({ text }) });
  await warmImmediately(harness);
  const snapshot = harness.cache.snapshot();

  assert.ok(snapshot);
  assert.ok(snapshot.metadata.sources.some((source) => source.ref === "initiative-a/status.md"));
  assert.ok(harness.calls.git.some((args) => args.includes("rev-parse") && args.includes("--show-toplevel")));
  assert.ok(harness.calls.git.some((args) => args.includes("rev-parse") && args.includes("--git-common-dir")));
  assert.ok(harness.calls.git.some((args) => args.includes("rev-parse") && args.includes("--git-path") && args.includes("HEAD")));
  assert.ok(harness.calls.git.some((args) => args.includes("rev-parse") && args.includes("HEAD")));
  assert.ok(harness.calls.git.some((args) => args.includes("branch") && args.includes("--show-current")));
  assert.ok(harness.calls.readdir.includes(harness.vaultRoot));
  assert.equal(harness.calls.readdir.includes(`${harness.worktree}/project-notes`), false);
  assert.equal(harness.calls.stat.includes(`${harness.worktree}/.git/HEAD`), false);
  assert.ok(harness.calls.stat.includes(harness.linkedHead));
});

test("RED: comment loading failure does not suppress independently loaded vault grounding", async () => {
  const harness = makeHarness({ commentDiffFails: true, redact: (text) => ({ text }) });

  await assert.doesNotReject(() => warmImmediately(harness));
  const snapshot = harness.cache.snapshot();

  assert.ok(snapshot, "vault grounding should still produce a snapshot");
  assert.ok(snapshot.brief.includes("Initiative overview"), "vault content must survive comment failure");
  assert.equal(snapshot.metadata.commentFiles, 0, "failed comment loading must produce no comment metadata");
  assert.equal(snapshot.metadata.sources.some(({ kind }) => kind === "repo-comment"), false);
});

test("absolute and repository-relative note directory overrides select only that source root", async () => {
  for (const [notesDir, notesRoot] of [
    ["/shared/project-notes", "/shared/project-notes"],
    ["docs/context", "/repo/project/docs/context"],
  ]) {
    const harness = makeHarness({ notesDir, notesRoot, configOverrides: { sources: ["project-notes"] } });
    await warmImmediately(harness);
    const snapshot = harness.cache.snapshot();
    assert.ok(snapshot, `expected notes from ${notesRoot}`);
    assert.ok(snapshot.brief.includes("Initiative overview"));
    assert.ok(harness.calls.readdir.includes(notesRoot));
    assert.equal(harness.calls.readdir.includes("/repo/project/.compass/notes"), false);
    assert.ok(snapshot.metadata.sources.every(({ kind, ref }) => kind === "project-notes" && !ref.startsWith("/")));
    harness.cache.stop();
  }
});

test("repository-comments-only config does not inspect project notes", async () => {
  const harness = makeHarness({ configOverrides: { sources: ["repo-comments"] } });
  await warmImmediately(harness);
  const snapshot = harness.cache.snapshot();
  assert.ok(snapshot);
  assert.ok(snapshot.brief.includes("changed comment"));
  assert.deepEqual(harness.calls.readdir, []);
  assert.ok(harness.calls.readFile.every((path) => path.startsWith(`${harness.worktree}/`)));
  assert.deepEqual(snapshot.metadata.sources.map(({ kind }) => kind), ["repo-comment"]);
  harness.cache.stop();
});

test("revision fingerprint changes for config, branch, HEAD, and source content but not identical inputs", async () => {
  const harness = makeHarness({ redact: (text) => ({ text }) });
  await warmImmediately(harness);
  const revision = () => harness.cache.snapshot()?.revision;
  let previous = revision();
  assert.equal(previous, 1);

  await refresh(harness);
  assert.equal(revision(), previous, "identical inputs must not rebuild");

  harness.state.config.tokenBudget = 128;
  await refresh(harness);
  assert.ok(revision() > previous);
  previous = revision();

  harness.state.config.sources = ["project-notes"];
  await refresh(harness);
  assert.ok(revision() > previous);
  previous = revision();

  harness.state.config.sources = ["project-notes", "repo-comments"];
  await refresh(harness);
  assert.ok(revision() > previous);
  previous = revision();

  harness.state.branch = "feat/PROJ-124-grounding";
  await refresh(harness);
  assert.ok(revision() > previous);
  previous = revision();

  harness.state.head = "head-2";
  await refresh(harness);
  assert.ok(revision() > previous);
  previous = revision();

  harness.state.files.set("/repo/project/.compass/notes/initiative-a/status.md", "changed vault content");
  await refresh(harness);
  assert.ok(revision() > previous);
  previous = revision();

  harness.state.files.set("/repo/project-feature/src/app.mjs", "// changed comment content");
  await refresh(harness);
  assert.ok(revision() > previous);
});

test("a successful refresh restores unchanged grounding after a transient Git failure", async () => {
  const harness = makeHarness({ redact: (text) => ({ text }) });
  await warmImmediately(harness);
  const initial = harness.cache.snapshot();
  assert.ok(initial);

  harness.state.failGit = true;
  await refresh(harness);
  assert.equal(harness.cache.snapshot(), null);

  harness.state.failGit = false;
  await refresh(harness);
  const recovered = harness.cache.snapshot();
  assert.ok(recovered, "an unchanged fingerprint must not suppress recovery");
  assert.equal(recovered.brief, initial.brief);
  assert.ok(recovered.revision > initial.revision);
  harness.cache.stop();
});

test("RED: noteToolActivity schedules a debounced background warm for changed content", async () => {
  const harness = makeHarness({ redact: (text) => ({ text }) });
  await warmImmediately(harness);
  const previous = harness.cache.snapshot();
  assert.ok(previous);

  harness.state.files.set("/repo/project/.compass/notes/initiative-a/status.md", "updated vault content");
  harness.cache.noteToolActivity();
  await harness.timers.advance(1_000);

  const snapshot = harness.cache.snapshot();
  assert.ok(snapshot, "background warm should retain a snapshot");
  assert.ok(snapshot.revision > previous.revision, "tool activity should trigger a new warm before the periodic cycle");
  assert.ok(snapshot.brief.includes("updated vault content"));
});

test("warm telemetry is empty; recordInjection records one bounded occurrence per call", async () => {
  const harness = makeHarness({ redact: (text) => ({ text }) });
  await warmImmediately(harness);
  const snapshot = harness.cache.snapshot();
  assert.ok(snapshot);
  assert.deepEqual(harness.cache.drainMetadata(), [], "warming is not an injection occurrence");

  const before = harness.calls.git.length + harness.calls.readdir.length + harness.calls.readFile.length;
  harness.cache.recordInjection("occurrence-1");
  harness.cache.recordInjection();
  const after = harness.calls.git.length + harness.calls.readdir.length + harness.calls.readFile.length;
  assert.equal(after, before, "recordInjection must not perform I/O");

  const occurrences = harness.cache.drainMetadata();
  assert.equal(occurrences.length, 2);
  assert.deepEqual(occurrences[0], { metadata: snapshot.metadata, occurrenceID: "occurrence-1" });
  assert.equal(typeof occurrences[1].occurrenceID, "string");
  assert.notEqual(occurrences[1].occurrenceID, occurrences[0].occurrenceID);
  assert.deepEqual(harness.cache.drainMetadata(), []);

  for (let index = 0; index < 300; index += 1) harness.cache.recordInjection(`occurrence-${index}`);
  const bounded = harness.cache.drainMetadata();
  assert.equal(bounded.length, 256);
  assert.equal(bounded[0].occurrenceID, "occurrence-44");
  assert.equal(bounded.at(-1).occurrenceID, "occurrence-299");
});

test("buildBrief truncates schema-maximum input within a linear CI budget", () => {
  const tokenBudget = 16_384;
  const started = performance.now();
  const result = buildBrief({
    initiativeDir: { dir: "/repo/project/.compass/notes/initiative-a", vaultDir: "/repo/project/.compass/notes", reason: "ticket" },
    vaultDocs: [{
      title: "Large document",
      path: "/repo/project/.compass/notes/initiative-a/status.md",
      text: "x".repeat(1024 * 1024),
    }],
    commentBlocks: [],
    config: config({ tokenBudget }),
    redact: (text) => ({ text }),
  });
  const elapsed = performance.now() - started;

  assert.ok(elapsed < 250, `schema-max truncation took ${elapsed.toFixed(1)}ms`);
  assert.ok(Buffer.byteLength(result.text, "utf8") <= tokenBudget * 4);
  assert.ok(result.metadata.bytes <= tokenBudget * 4);
});

test("matchInitiative keeps ticket, folder-overlap, and no-match behavior", () => {
  const fs = fakeMatchFS({
    "/project-notes/initiative-a/status.md": "Tracks PROJ-123",
    "/project-notes/dependency-update/status.md": "Dependency update status",
    "/project-notes/unrelated/status.md": "No matching branch token",
  });
  assert.deepEqual(matchInitiative("feat/proj-123-grounding", "/project-notes", fs), {
    dir: "/project-notes/initiative-a",
    reason: "ticket",
  });
  assert.deepEqual(matchInitiative("feat/dependency-update-grounding", "/project-notes", fs), {
    dir: "/project-notes/dependency-update",
    reason: "branch-folder-overlap",
  });
  assert.equal(matchInitiative("feat/other-work", "/project-notes", fs), null);
  assert.equal(matchInitiative("", "/project-notes", fs), null);
  assert.equal(matchInitiative(undefined, "/project-notes", fs), null);
});
