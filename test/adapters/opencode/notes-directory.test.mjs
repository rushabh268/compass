import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import test from "node:test";

import { createGroundingCache } from "../../../adapters/opencode/grounding.mjs";

const execute = promisify(execFile);
const policy = { schemaVersion: 1, enabled: true, tokenBudget: 512, deadlineMs: 1000, sources: ["project-notes"] };

async function git(directory, ...args) {
  return execute("git", ["-C", directory, "-c", "commit.gpgsign=false", "-c", "user.name=Fixture Author",
    "-c", "user.email=fixture@example.invalid", ...args], { timeout: 5000 });
}

async function repository(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ah-notes-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const main = join(root, "project");
  await mkdir(main);
  await git(main, "init", "--initial-branch=feature/PROJ-123-main");
  await git(main, "commit", "--allow-empty", "-m", "Synthetic test repository");
  return { root, main };
}

async function note(directory, text) {
  const initiative = join(directory, "context");
  await mkdir(initiative, { recursive: true });
  await writeFile(join(initiative, "status.md"), `PROJ-123\n${text}\n`);
}

async function warmed(worktree, overrides = {}) {
  const cache = createGroundingCache({ worktree, notesDir: "", loadConfig: async () => policy, ...overrides });
  try {
    cache.start();
    const deadline = Date.now() + 3000;
    while (!cache.snapshot() && Date.now() < deadline) await delay(10);
    assert.ok(cache.snapshot(), "real Git and filesystem sources must produce a grounding snapshot");
    return cache.snapshot();
  } finally {
    cache.stop();
  }
}

test("normal, linked, and nested worktrees share notes from the main checkout", { timeout: 15_000 }, async (t) => {
  const { root, main } = await repository(t);
  const linked = join(root, "project-linked");
  const nested = join(main, ".worktrees", "nested");
  await git(main, "worktree", "add", "-b", "feature/PROJ-123-linked", linked);
  await git(main, "worktree", "add", "-b", "feature/PROJ-123-nested", nested);
  await note(join(main, ".agent-harness", "notes"), "Shared design decision from the main checkout");

  for (const worktree of [main, linked, nested]) {
    const snapshot = await warmed(worktree);
    assert.match(snapshot.brief, /Shared design decision from the main checkout/);
    assert.deepEqual(snapshot.metadata.sources, [{ kind: "project-notes", ref: "context/status.md" }]);
    assert.equal(snapshot.metadata.matchReason, "ticket");
    assert.equal(JSON.stringify(snapshot.metadata).includes(root), false);
  }
});

test("a relative notes override resolves from the main checkout of a nested worktree", { timeout: 10_000 }, async (t) => {
  const { main } = await repository(t);
  const nested = join(main, ".worktrees", "nested");
  await git(main, "worktree", "add", "-b", "feature/PROJ-123-nested", nested);
  await note(join(main, "docs", "context"), "Repository-relative override");
  const snapshot = await warmed(nested, { notesDir: "docs/context" });
  assert.match(snapshot.brief, /Repository-relative override/);
  assert.deepEqual(snapshot.metadata.sources, [{ kind: "project-notes", ref: "context/status.md" }]);
});

test("the environment notes override can select an independent notes directory", { timeout: 10_000 }, async (t) => {
  const { root, main } = await repository(t);
  const notes = join(root, "shared-notes");
  await note(notes, "Independent notes directory");
  const previous = process.env.AGENT_HARNESS_NOTES_DIR;
  try {
    process.env.AGENT_HARNESS_NOTES_DIR = notes;
    const snapshot = await warmed(main, { notesDir: undefined });
    assert.match(snapshot.brief, /Independent notes directory/);
    assert.equal(snapshot.metadata.sources[0].ref, "context/status.md");
  } finally {
    if (previous === undefined) delete process.env.AGENT_HARNESS_NOTES_DIR;
    else process.env.AGENT_HARNESS_NOTES_DIR = previous;
  }
});
