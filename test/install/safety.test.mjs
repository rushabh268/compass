import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import * as plan from "../../install/plan.mjs";
import { run as bootstrap } from "../../install/bootstrap.mjs";
import { run as uninstall } from "../../install/uninstall.mjs";

const execFileAsync = promisify(execFile);

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), "harness-install-safety-"));
  const repoRoot = join(home, "repository");
  const codexHome = join(home, ".codex");
  const calls = [];
  t.after(() => rm(home, { recursive: true, force: true }));
  return {
    home, repoRoot, codexHome, calls,
    targets: plan.resolveTargets({ home, repoRoot, codexHome }),
    runCommand: async (...args) => { calls.push(args); return { code: 0, stdout: "", stderr: "" }; },
    skipRuntime: true, skipLaunchd: true,
  };
}

async function write(path, text, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, text, { mode });
}

async function absent(path) {
  await assert.rejects(stat(path), { code: "ENOENT" });
}

test("all selected client shapes are validated before state, runtime, or launchd mutations", async (t) => {
  for (const [client, content] of [["claudeSettings", "[]"], ["claudeSettings", '{"hooks":{"Stop":{}}}'], ["opencodeConfig", '{"plugin":true}'], ["opencodeConfig", "[]"], ["codexHooks", "{"], ["codexHooks", '{"hooks":{"Stop":[{"hooks":{}}]}}']]) {
    const setup = await fixture(t);
    const path = client === "codexHooks" ? join(setup.codexHome, "hooks.json") : setup.targets[client];
    await write(path, content);
    await assert.rejects(bootstrap({ ...setup, adapters: ["claude", "opencode", "codex"], skipRuntime: false, skipLaunchd: false }));
    assert.deepEqual(setup.calls, []);
    assert.equal(await readFile(path, "utf8"), content);
    await absent(setup.targets.stateDir);
    await absent(setup.targets.wrapperPath);
    await absent(setup.targets.plistPath);
    await absent(join(setup.home, ".local/share/agent-harness-runtime"));
    await absent(`${path}.agent-harness.bak`);
  }
});

test("installer rejects symlinked configs, parents, state, artifacts, and backup paths", async (t) => {
  for (const targetName of ["codexFile", "codexParent", "stateDir", "keyFile", "coalescingConfig", "groundingConfig", "wrapperPath", "plistPath", "backup", "socket"]) {
    const setup = await fixture(t);
    const external = join(setup.home, "external");
    const destination = join(external, "sentinel");
    await mkdir(external, { mode: 0o700 });
    await write(destination, "do not change this");
    let linkPath;
    let linkTarget = destination;
    if (targetName === "codexFile") linkPath = join(setup.codexHome, "hooks.json");
    else if (targetName === "codexParent") { linkPath = setup.codexHome; linkTarget = external; }
    else if (targetName === "stateDir") { linkPath = setup.targets.stateDir; linkTarget = external; }
    else if (targetName === "backup") {
      await write(join(setup.codexHome, "hooks.json"), '{"description":"original"}');
      linkPath = join(setup.codexHome, "hooks.json.agent-harness.bak");
    } else linkPath = setup.targets[targetName];
    await mkdir(dirname(linkPath), { recursive: true, mode: 0o700 });
    await symlink(linkTarget, linkPath);
    await assert.rejects(bootstrap({ ...setup, adapters: ["codex"], skipRuntime: false, skipLaunchd: false }), /symlink/i);
    assert.equal(await readFile(destination, "utf8"), "do not change this");
    assert.deepEqual(setup.calls, []);
  }
});

test("read-only client configuration fails preflight without changing permissions", async (t) => {
  const setup = await fixture(t);
  const path = join(setup.codexHome, "hooks.json");
  await write(path, '{"description":"read only"}', 0o400);
  await assert.rejects(bootstrap({ ...setup, adapters: ["codex"] }), /writ|permission/i);
  assert.equal((await stat(path)).mode & 0o777, 0o400);
  assert.equal(await readFile(path, "utf8"), '{"description":"read only"}');
  await absent(setup.targets.stateDir);
});

test("bootstrap accepts an existing owned supervisor socket during reinstall", async (t) => {
  const setup = await fixture(t);
  const home = await mkdtemp("/tmp/ah-install-socket-");
  const targets = plan.resolveTargets({ home, repoRoot: setup.repoRoot });
  await mkdir(targets.stateDir, { recursive: true, mode: 0o700 });
  const server = createServer((socket) => socket.end());
  t.after(async () => {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await rm(home, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(targets.socket, resolve);
  });
  await bootstrap({ ...setup, home, codexHome: join(home, ".codex") });
  assert.equal(server.listening, true);
  assert.equal((await stat(targets.socket)).isSocket(), true);
});

test("existing directory and key permissions are never silently widened or repaired", async (t) => {
  const setup = await fixture(t);
  await mkdir(setup.targets.stateDir, { recursive: true, mode: 0o755 });
  await chmod(setup.targets.stateDir, 0o755);
  await assert.rejects(bootstrap(setup), /0700|permission/);
  assert.equal((await stat(setup.targets.stateDir)).mode & 0o777, 0o755);
  await chmod(setup.targets.stateDir, 0o700);
  await write(setup.targets.keyFile, "x".repeat(32), 0o644);
  await assert.rejects(bootstrap(setup), /0600|permission/);
  assert.equal((await stat(setup.targets.keyFile)).mode & 0o777, 0o644);
  assert.equal(await readFile(setup.targets.keyFile, "utf8"), "x".repeat(32));
  assert.deepEqual(setup.calls, []);
});

test("uninstall validates every client before disconnecting any of them or stopping launchd", async (t) => {
  const setup = await fixture(t);
  await bootstrap({ ...setup, adapters: ["claude", "opencode", "codex"] });
  const claudeBefore = await readFile(setup.targets.claudeSettings, "utf8");
  await write(join(setup.codexHome, "hooks.json"), "malformed {");
  await assert.rejects(uninstall({ ...setup, skipLaunchd: false }));
  assert.deepEqual(setup.calls, []);
  assert.equal(await readFile(setup.targets.claudeSettings, "utf8"), claudeBefore);
  assert.ok(await stat(setup.targets.wrapperPath));
  assert.ok(await stat(setup.targets.plistPath));
});

test("uninstall refuses a recorded Codex path replaced with a symlink", async (t) => {
  const setup = await fixture(t);
  const customHome = join(setup.home, "custom-codex");
  const path = join(customHome, "hooks.json");
  await bootstrap({ ...setup, codexHome: customHome, adapters: ["codex"] });
  const elsewhere = join(setup.home, "unrelated-hooks.json");
  const original = await readFile(path, "utf8");
  await write(elsewhere, original);
  await rm(path);
  await symlink(elsewhere, path);
  await assert.rejects(uninstall({ ...setup, skipLaunchd: false }), /symlink/i);
  assert.equal(await readFile(elsewhere, "utf8"), original);
  assert.deepEqual(setup.calls, []);
  assert.ok(await stat(setup.targets.wrapperPath));
});

test("installation manifest is closed, bounded, and uses absolute paths", async (t) => {
  const registration = { path: "/tmp/hooks.json", command: "command" };
  const invalid = [
    { schemaVersion: 2, adapters: ["claude"], codex: [] },
    { schemaVersion: 1, adapters: ["claude"], codex: [], unexpected: true },
    { schemaVersion: 1, adapters: ["codex"], codex: [{ ...registration, path: "relative/hooks.json" }] },
    { schemaVersion: 1, adapters: ["codex"], codex: Array.from({ length: 17 }, () => registration) },
    { schemaVersion: 1, adapters: ["codex"], codex: [{ ...registration, command: 2 }] },
    { schemaVersion: 1, adapters: ["codex", "codex"], codex: [registration] },
    { schemaVersion: 1, adapters: ["unknown"], codex: [] },
    { schemaVersion: 1, adapters: null, codex: [] },
    { schemaVersion: 1, adapters: ["claude"], codex: [registration] },
  ];
  for (const value of invalid) {
    const setup = await fixture(t);
    await write(join(setup.targets.stateDir, "installation.json"), JSON.stringify(value));
    await assert.rejects(bootstrap({ ...setup, adapters: ["codex"] }), /manifest/i);
    assert.deepEqual(setup.calls, []);
    await absent(setup.targets.keyFile);
  }
});

test("shell commands, environment, plugin URL, and plist preserve literal metacharacters", async (t) => {
  const setup = await fixture(t);
  const home = join(setup.home, "home ' $(touch injected) `touch injected` $PATH & < >");
  const repoRoot = join(setup.home, "repo ' $(touch injected) `touch injected` $PATH & < >");
  const targets = plan.resolveTargets({ home, repoRoot });
  await write(targets.runtimeNodeBin, '#!/bin/sh\nprintf "%s\\n" "$AGENT_HARNESS_SOCKET" "$AGENT_HARNESS_KEY_FILE" "$@"\n', 0o755);
  const wrapper = plan.renderSupervisorWrapper(targets);
  await write(targets.wrapperPath, wrapper, 0o755);
  const wrapperRun = await execFileAsync("/bin/sh", [targets.wrapperPath], { cwd: setup.home });
  assert.deepEqual(wrapperRun.stdout.trimEnd().split("\n").slice(2), [targets.cliEntry, "serve", "--socket", targets.socket, "--key-file", targets.keyFile, "--ledger", targets.ledger]);
  for (const [command, hook] of [[plan.claudeHookCommand(targets), targets.claudeHook], [plan.codexHookCommand(targets), targets.codexHook]]) {
    const result = await execFileAsync("/bin/sh", ["-c", command], { cwd: setup.home });
    assert.deepEqual(result.stdout.trimEnd().split("\n"), [targets.socket, targets.keyFile, hook]);
  }
  await write(targets.zshenv, plan.zshenvBlock(targets));
  const sourced = await execFileAsync("/bin/sh", ["-c", '. "$1"; printf "%s\\n" "$AGENT_HARNESS_SOCKET" "$AGENT_HARNESS_KEY_FILE" "$AGENT_HARNESS_COALESCING_CONFIG" "$AGENT_HARNESS_GROUNDING_CONFIG"', "test-env", targets.zshenv], { cwd: setup.home });
  assert.deepEqual(sourced.stdout.trimEnd().split("\n"), [targets.socket, targets.keyFile, targets.coalescingConfig, targets.groundingConfig]);
  await write(targets.plistPath, plan.renderLaunchdPlist(targets));
  const converted = await execFileAsync("plutil", ["-convert", "json", "-o", "-", "--", targets.plistPath]);
  const plist = JSON.parse(converted.stdout);
  assert.equal(plist.Label, "local.agent-harness");
  assert.deepEqual(plist.ProgramArguments, [targets.wrapperPath]);
  assert.equal(plist.EnvironmentVariables.HOME, home);
  assert.equal(plist.StandardOutPath, targets.outLog);
  assert.equal(plist.StandardErrorPath, targets.errLog);
  const plugin = plan.insertOpenCodePlugin(null, targets);
  assert.deepEqual(JSON.parse(plugin.text).plugin, [pathToFileURL(targets.opencodePlugin).href]);
  assert.equal(plan.removeOpenCodePlugin(plugin.text, targets).changed, true);
  await absent(join(setup.home, "injected"));
});

test("OpenCode JSONC validation does not alter punctuation inside string values", () => {
  const targets = plan.resolveTargets({ home: "/Users/example", repoRoot: "/repo/project" });
  const original = '{"custom":"a,} and b,]", "plugin": [],}';
  const inserted = plan.insertOpenCodePlugin(original, targets);
  assert.ok(inserted.text.includes('"a,} and b,]"'));
  // An existing plugin must be found without corrupting punctuation while parsing.
  const once = '{"custom":"a,}","plugin":["file:///repo/project/adapters/opencode/server.js",],}';
  assert.equal(plan.insertOpenCodePlugin(once, targets).changed, false);
  assert.throws(() => plan.insertOpenCodePlugin('{} /* unterminated', targets));
});
