import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  applyZshenv,
  claudeHookCommand,
  insertOpenCodePlugin,
  mergeClaudeSettings,
  removeOpenCodePlugin,
  removeZshenv,
  renderCoalescingConfig,
  renderLaunchdPlist,
  renderSupervisorWrapper,
  resolveTargets,
  zshenvBlock,
} from "../../install/plan.mjs";
import { run as bootstrap } from "../../install/bootstrap.mjs";
import { run as uninstall } from "../../install/uninstall.mjs";

const FOREIGN_USER = "/Users/example";

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), "agent-harness-install-home-"));
  const repoRoot = await mkdtemp(join(tmpdir(), "agent-harness-install-repo-"));
  t.after(async () => {
    await Promise.all([
      rm(home, { recursive: true, force: true }),
      rm(repoRoot, { recursive: true, force: true }),
    ]);
  });
  return { home, repoRoot, targets: resolveTargets({ home, repoRoot }) };
}

function fakeRunner() {
  const calls = [];
  return {
    calls,
    runCommand: async (...args) => {
      calls.push(args);
      return { status: 0, stdout: "", stderr: "" };
    },
  };
}

function commandText(calls) {
  return JSON.stringify(calls);
}

async function mode(path) {
  return (await stat(path)).mode & 0o777;
}

async function snapshotFiles(root) {
  const snapshot = new Map();
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else snapshot.set(path, await readFile(path));
    }
  }
  await visit(root);
  return snapshot;
}

async function assertNoForeignUser(root) {
  const snapshot = await snapshotFiles(root);
  for (const [path, content] of snapshot) {
    assert.equal(content.toString("utf8").includes(FOREIGN_USER), false, `${path} contains a foreign user's home`);
  }
}

async function writeFixtureSettings(targets) {
  const claude = {
    hooks: {
      Stop: [{ matcher: "", hooks: [{ type: "command", command: "echo retain-stop" }] }],
      UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo retain-event" }] }],
    },
    permissions: { allow: ["Bash(git status)"] },
  };
  const opencode = `{
  // Preserve this comment.
  "mcp": { "keep": true },
  "plugin": ["file://other-plugin"],
}`;
  const zshenv = "export OPENCODE_SERVER_PASSWORD=guard\n# preserve this line\n";
  await Promise.all([
    mkdir(dirname(targets.claudeSettings), { recursive: true }),
    mkdir(dirname(targets.opencodeConfig), { recursive: true }),
  ]);
  await writeFile(targets.claudeSettings, JSON.stringify(claude, null, 2) + "\n");
  await writeFile(targets.opencodeConfig, opencode);
  await writeFile(targets.zshenv, zshenv);
  return { claude, opencode, zshenv };
}

test("bootstrap creates secure state, key, policy, wrapper, and plist using parameterized paths", async (t) => {
  const { home, repoRoot, targets } = await fixture(t);
  const runner = fakeRunner();
  const result = await bootstrap({ home, repoRoot, runCommand: runner.runCommand, dryRun: false, skipRuntime: true, skipLaunchd: true, now: new Date("2026-09-03T00:00:00Z") });

  assert.equal(await mode(targets.stateDir), 0o700);
  assert.equal((await readFile(targets.keyFile)).length >= 32, true);
  assert.equal(await mode(targets.keyFile), 0o600);
  assert.equal(await readFile(targets.coalescingConfig, "utf8"), renderCoalescingConfig());
  assert.equal(await mode(targets.coalescingConfig), 0o600);
  assert.equal(await mode(targets.wrapperPath), 0o755);
  assert.equal(await readFile(targets.wrapperPath, "utf8"), renderSupervisorWrapper(targets));
  assert.equal(await readFile(targets.plistPath, "utf8"), renderLaunchdPlist(targets));
  assert.equal(result.dryRun, false);
  assert.equal(JSON.stringify(result).includes(FOREIGN_USER), false);
  await assertNoForeignUser(home);
});

test("bootstrap does not overwrite an existing key or coalescing policy", async (t) => {
  const { home, repoRoot, targets } = await fixture(t);
  await mkdir(targets.stateDir, { recursive: true, mode: 0o700 });
  const sentinelKey = Buffer.from("sentinel-auth-key-that-must-remain");
  const sentinelConfig = JSON.stringify({ schemaVersion: 1, enabled: false, preserveLabels: ["lifecycle", "tool", "permission", "error"], dlpOverride: true });
  await writeFile(targets.keyFile, sentinelKey, { mode: 0o600 });
  await writeFile(targets.coalescingConfig, sentinelConfig, { mode: 0o600 });
  const runner = fakeRunner();

  await bootstrap({ home, repoRoot, runCommand: runner.runCommand, skipRuntime: true, skipLaunchd: true });

  assert.deepEqual(await readFile(targets.keyFile), sentinelKey);
  assert.equal(await readFile(targets.coalescingConfig, "utf8"), sentinelConfig);
});

test("bootstrap backs up and merges existing Claude, OpenCode, and zshenv configuration", async (t) => {
  const { home, repoRoot, targets } = await fixture(t);
  const original = await writeFixtureSettings(targets);
  const runner = fakeRunner();

  await bootstrap({ home, repoRoot, runCommand: runner.runCommand, skipRuntime: true, skipLaunchd: true });

  assert.equal(await readFile(`${targets.claudeSettings}.bak`, "utf8"), JSON.stringify(original.claude, null, 2) + "\n");
  assert.equal(await readFile(`${targets.opencodeConfig}.bak`, "utf8"), original.opencode);
  assert.equal(await readFile(`${targets.zshenv}.bak`, "utf8"), original.zshenv);
  assert.deepEqual(JSON.parse(await readFile(targets.claudeSettings, "utf8")), mergeClaudeSettings(original.claude, targets).settings);
  const plannedOpenCode = insertOpenCodePlugin(original.opencode, targets);
  assert.equal(await readFile(targets.opencodeConfig, "utf8"), plannedOpenCode.text);
  assert.equal(await readFile(targets.zshenv, "utf8"), applyZshenv(original.zshenv, targets).text);
});

test("bootstrap validates all config transforms before mutating any config file", async (t) => {
  const { home, repoRoot, targets } = await fixture(t);
  const claude = {
    permissions: { allow: ["Bash(git status)"] },
  };
  const claudeText = `${JSON.stringify(claude, null, 2)}\n`;
  const zshenvText = "export OPENCODE_SERVER_PASSWORD=guard\n# preserve this line\n";
  const malformedOpenCode = `{
  "autoupdate": false,
  "mcp": { "x": {}
`;

  await Promise.all([
    mkdir(dirname(targets.claudeSettings), { recursive: true }),
    mkdir(dirname(targets.opencodeConfig), { recursive: true }),
  ]);
  await writeFile(targets.claudeSettings, claudeText);
  await writeFile(targets.opencodeConfig, malformedOpenCode);
  await writeFile(targets.zshenv, zshenvText);

  const runner = fakeRunner();
  await assert.rejects(
    bootstrap({ home, repoRoot, runCommand: runner.runCommand, skipRuntime: true, skipLaunchd: true }),
  );

  assert.equal(await readFile(targets.claudeSettings, "utf8"), claudeText);
  assert.equal(await readFile(targets.opencodeConfig, "utf8"), malformedOpenCode);
  assert.equal(await readFile(targets.zshenv, "utf8"), zshenvText);
  for (const path of [targets.claudeSettings, targets.opencodeConfig, targets.zshenv]) {
    assert.equal(await exists(`${path}.agent-harness.bak`), false);
    assert.equal(await exists(`${path}.bak`), false);
  }
});

test("bootstrap is idempotent and does not duplicate hooks, plugins, or zshenv blocks", async (t) => {
  const { home, repoRoot, targets } = await fixture(t);
  await writeFixtureSettings(targets);
  const runner = fakeRunner();
  const options = { home, repoRoot, runCommand: runner.runCommand, skipRuntime: true, skipLaunchd: true };
  const first = await bootstrap(options);
  const firstFiles = await snapshotFiles(home);
  const firstCalls = runner.calls.length;
  const second = await bootstrap(options);
  const secondFiles = await snapshotFiles(home);

  assert.equal(second.changed.claudeSettings, false);
  assert.equal(second.changed.opencodeConfig, false);
  assert.equal(second.changed.zshenv, false);
  assert.equal(second.changed.wrapper, false);
  assert.equal(second.changed.plist, false);
  assert.equal(second.changed.coalescingConfig, false);
  assert.equal(second.changed.keyFile, false);
  assert.deepEqual([...secondFiles.keys()], [...firstFiles.keys()]);
  for (const [path, content] of firstFiles) assert.deepEqual(secondFiles.get(path), content, `${path} changed on second run`);
  assert.equal(runner.calls.length, firstCalls);
  assert.equal(first.changed.claudeSettings, true);
  assert.equal((await readFile(targets.zshenv, "utf8")).split("BEGIN agent-harness").length - 1, 1);
});

test("dryRun reports a plan without writing files or invoking commands", async (t) => {
  const { home, repoRoot } = await fixture(t);
  const runner = fakeRunner();
  const result = await bootstrap({ home, repoRoot, runCommand: runner.runCommand, dryRun: true, skipRuntime: false, skipLaunchd: false });

  assert.equal(result.dryRun, true);
  assert.ok(result.plan);
  assert.deepEqual(await readdir(home), []);
  assert.deepEqual(runner.calls, []);
});

test("runtime and launchd controls gate their injectable commands", async (t) => {
  const { home, repoRoot } = await fixture(t);
  const runner = fakeRunner();

  await bootstrap({ home, repoRoot, runCommand: runner.runCommand, skipRuntime: true, skipLaunchd: true });
  assert.equal(commandText(runner.calls).includes("npm"), false);
  assert.equal(commandText(runner.calls).includes("launchctl"), false);

  const secondRunner = fakeRunner();
  const secondHome = await mkdtemp(join(tmpdir(), "agent-harness-install-command-home-"));
  t.after(() => rm(secondHome, { recursive: true, force: true }));
  await bootstrap({ home: secondHome, repoRoot, runCommand: secondRunner.runCommand, skipRuntime: false, skipLaunchd: false });
  assert.match(commandText(secondRunner.calls), /npm[\s\S]*install[\s\S]*node@24\.19\.0/);
  assert.match(commandText(secondRunner.calls), /launchctl[\s\S]*bootstrap/);
});

test("uninstall removes installed artifacts, calls bootout, and preserves state by default", async (t) => {
  const { home, repoRoot, targets } = await fixture(t);
  const original = await writeFixtureSettings(targets);
  const bootstrapRunner = fakeRunner();
  await bootstrap({ home, repoRoot, runCommand: bootstrapRunner.runCommand, skipRuntime: true, skipLaunchd: true });
  const keyBeforeUninstall = await readFile(targets.keyFile);
  const ledgerBeforeUninstall = Buffer.from("ledger-must-survive-default-uninstall");
  await writeFile(targets.ledger, ledgerBeforeUninstall, { mode: 0o600 });
  const uninstallRunner = fakeRunner();

  await uninstall({ home, repoRoot, codexHome: join(home, ".codex"), runCommand: uninstallRunner.runCommand });

  assert.equal(await exists(targets.wrapperPath), false);
  assert.equal(await exists(targets.plistPath), false);
  assert.match(commandText(uninstallRunner.calls), /launchctl[\s\S]*bootout/);
  assert.equal(await exists(targets.stateDir), true);
  assert.deepEqual(await readFile(targets.keyFile), keyBeforeUninstall);
  assert.deepEqual(await readFile(targets.ledger), ledgerBeforeUninstall);
  assert.equal(await readFile(targets.claudeSettings, "utf8"), JSON.stringify(original.claude, null, 2) + "\n");
  assert.equal(await readFile(targets.opencodeConfig, "utf8"), removeOpenCodePlugin(insertOpenCodePlugin(original.opencode, targets).text, targets).text);
  assert.equal(await readFile(targets.zshenv, "utf8"), removeZshenv(applyZshenv(original.zshenv, targets).text).text);
});

test("uninstall purgeState removes state only when explicitly requested", async (t) => {
  const { home, repoRoot, targets } = await fixture(t);
  const runner = fakeRunner();
  await bootstrap({ home, repoRoot, runCommand: runner.runCommand, skipRuntime: true, skipLaunchd: true });
  await uninstall({ home, repoRoot, codexHome: join(home, ".codex"), runCommand: runner.runCommand, purgeState: true });

  assert.equal(await exists(targets.stateDir), false);
  assert.equal(await exists(targets.keyFile), false);
  assert.equal(await exists(targets.ledger), false);
});

test("bootstrap's generated environment contract uses the exact planned command paths", async (t) => {
  const { home, repoRoot, targets } = await fixture(t);
  const runner = fakeRunner();
  await bootstrap({ home, repoRoot, runCommand: runner.runCommand, skipRuntime: true, skipLaunchd: true });

  const settings = JSON.parse(await readFile(targets.claudeSettings, "utf8"));
  const zshenv = await readFile(targets.zshenv, "utf8");
  const hookCommands = Object.values(settings.hooks).flatMap((groups) =>
    groups.flatMap((group) => group.hooks ?? []).map((hook) => hook.command),
  );
  assert.equal(hookCommands.includes(claudeHookCommand(targets)), true);
  assert.equal(zshenv.includes(zshenvBlock(targets)), true);
  assert.equal(JSON.stringify({ settings, zshenv }).includes(FOREIGN_USER), false);
});

test("bootstrap creates grounding.json with mode 0600 create-if-absent", async (t) => {
  const { home, repoRoot, targets } = await fixture(t);
  const runner = fakeRunner();

  await bootstrap({ home, repoRoot, runCommand: runner.runCommand, skipRuntime: true, skipLaunchd: true });

  assert.equal(await exists(targets.groundingConfig), true, "grounding.json must be created");
  const fileMode = await mode(targets.groundingConfig);
  assert.equal(fileMode, 0o600, `grounding.json mode must be 0600, got ${(fileMode).toString(8)}`);

  // Verify it's valid JSON (empty or minimal config)
  const content = await readFile(targets.groundingConfig, "utf8");
  assert.doesNotThrow(() => JSON.parse(content), "grounding.json must be valid JSON");
});

test("bootstrap does NOT overwrite existing grounding.json", async (t) => {
  const { home, repoRoot, targets } = await fixture(t);
  const runner = fakeRunner();

  // Create grounding.json beforehand with distinctive content
  const existingPath = targets.groundingConfig;
  await mkdir(dirname(existingPath), { recursive: true, mode: 0o700 });
  const existingContent = JSON.stringify({ custom: "existing-config" });
  await writeFile(existingPath, existingContent, { mode: 0o600 });

  await bootstrap({ home, repoRoot, runCommand: runner.runCommand, skipRuntime: true, skipLaunchd: true });

  const newContent = await readFile(existingPath, "utf8");
  assert.equal(newContent, existingContent, "bootstrap must NOT overwrite existing grounding.json");
});

test("bootstrap grounding.json round-trips with uninstall", async (t) => {
  const { home, repoRoot, targets } = await fixture(t);
  const runner = fakeRunner();

  // Install
  await bootstrap({ home, repoRoot, runCommand: runner.runCommand, skipRuntime: true, skipLaunchd: true });
  assert.equal(await exists(targets.groundingConfig), true);
  const installedContent = await readFile(targets.groundingConfig, "utf8");

  // Uninstall
  await uninstall({ home, repoRoot, codexHome: join(home, ".codex"), runCommand: runner.runCommand, skipLaunchd: true });
  // After uninstall, grounding.json should still exist (it's part of state, not removed)
  // This verifies the uninstall doesn't break grounding persistence
  assert.equal(await exists(targets.groundingConfig), true, "grounding.json must persist after uninstall");
});

test("bootstrap dryRun writes NO files including grounding.json", async (t) => {
  const { home, repoRoot, targets } = await fixture(t);
  const runner = fakeRunner();

  await bootstrap({ home, repoRoot, runCommand: runner.runCommand, skipRuntime: true, skipLaunchd: true, dryRun: true });

  assert.equal(await exists(targets.groundingConfig), false, "dryRun must NOT create grounding.json");
  assert.equal(await exists(targets.claudeSettings), false, "dryRun must NOT create any files");
  assert.equal(await exists(targets.zshenv), false, "dryRun must NOT create zshenv");
});

test("bootstrap merges grounding.json with existing state directory consistently", async (t) => {
  const { home, repoRoot, targets } = await fixture(t);
  const runner = fakeRunner();

  // First install
  await bootstrap({ home, repoRoot, runCommand: runner.runCommand, skipRuntime: true, skipLaunchd: true });
  const firstContent = await readFile(targets.groundingConfig, "utf8");

  // Second install (idempotent)
  await bootstrap({ home, repoRoot, runCommand: runner.runCommand, skipRuntime: true, skipLaunchd: true });
  const secondContent = await readFile(targets.groundingConfig, "utf8");

  // Content should not change on re-install (merge is idempotent)
  assert.equal(firstContent, secondContent, "grounding.json must be stable across idempotent installs");
});
