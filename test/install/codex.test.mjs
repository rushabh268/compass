import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import * as plan from "../../install/plan.mjs";
import { run as bootstrap } from "../../install/bootstrap.mjs";
import { run as uninstall } from "../../install/uninstall.mjs";

const execFileAsync = promisify(execFile);
const events = ["SessionStart", "SessionEnd", "SubagentStart", "SubagentStop", "PreToolUse", "PermissionRequest", "PostToolUse", "PreCompact", "PostCompact", "UserPromptSubmit", "Stop", "Interrupt"];

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), "harness-codex-install-"));
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

async function writeConfig(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function absent(path) {
  await assert.rejects(stat(path), { code: "ENOENT" });
}

function ownedHooks(config, command) {
  return Object.entries(config.hooks).flatMap(([event, groups]) => groups.flatMap((group) =>
    group.hooks.filter((hook) => hook.command === command).map((hook) => ({ event, hook })),
  ));
}

test("Codex hooks install the documented event set as advisory background commands", async (t) => {
  const setup = await fixture(t);
  await bootstrap({ ...setup, adapters: ["codex"] });
  const path = join(setup.codexHome, "hooks.json");
  const config = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(new Set(Object.keys(config.hooks)), new Set(events));
  const command = plan.codexHookCommand(setup.targets);
  assert.equal(ownedHooks(config, command).length, events.length);
  for (const { event, hook } of ownedHooks(config, command)) {
    assert.equal(hook.type, "command");
    assert.equal(hook.timeout, 3);
    assert.equal(hook.async, event === "SessionEnd" ? undefined : true);
    assert.deepEqual(Object.keys(hook).sort(), (event === "SessionEnd" ? ["command", "timeout", "type"] : ["async", "command", "timeout", "type"]).sort());
  }
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await absent(setup.targets.claudeSettings);
  await absent(setup.targets.opencodeConfig);
  await absent(setup.targets.zshenv);
  await absent(join(setup.codexHome, "config.toml"));
});

test("default install never inspects or modifies an unselected Codex home", async (t) => {
  const setup = await fixture(t);
  const external = join(setup.home, "unselected-config");
  await mkdir(external);
  await writeFile(join(external, "hooks.json"), "invalid JSON must stay untouched");
  await symlink(external, setup.codexHome);
  await bootstrap(setup);
  assert.equal(await readFile(join(external, "hooks.json"), "utf8"), "invalid JSON must stay untouched");
  assert.deepEqual(await readdir(external), ["hooks.json"]);
  assert.ok(await stat(setup.targets.claudeSettings));
  assert.ok(await stat(setup.targets.opencodeConfig));
});

test("Claude-only uninstall leaves malformed or symlinked unselected Codex settings untouched", async (t) => {
  for (const kind of ["malformed", "symlink"]) {
    const setup = await fixture(t);
    const path = join(setup.codexHome, "hooks.json");
    await mkdir(setup.codexHome);
    if (kind === "symlink") {
      const external = join(setup.home, "external-codex.json");
      await writeFile(external, "unselected external configuration");
      await symlink(external, path);
    } else await writeFile(path, "malformed {");
    const before = await readFile(path, "utf8");
    await bootstrap({ ...setup, adapters: ["claude"] });
    await uninstall({ ...setup, skipLaunchd: false });
    assert.equal(await readFile(path, "utf8"), before);
    assert.equal((await lstat(path)).isSymbolicLink(), kind === "symlink");
    await absent(setup.targets.claudeSettings);
    await absent(setup.targets.wrapperPath);
    assert.equal(setup.calls.filter(([command]) => command === "launchctl").length, 1);
  }
});

test("Codex-only uninstall ignores unselected Claude, OpenCode, and shell configurations", async (t) => {
  for (const [key, kind] of [["claudeSettings", "malformed"], ["opencodeConfig", "malformed"], ["claudeSettings", "symlink"], ["opencodeConfig", "symlink"], ["zshenv", "symlink"]]) {
    const setup = await fixture(t);
    const path = setup.targets[key];
    await mkdir(dirname(path), { recursive: true });
    if (kind === "symlink") {
      const external = join(setup.home, "external-user-config");
      await writeFile(external, "unselected external configuration");
      await symlink(external, path);
    } else await writeFile(path, "malformed {");
    const before = await readFile(path, "utf8");
    await bootstrap({ ...setup, adapters: ["codex"] });
    await uninstall({ ...setup, skipLaunchd: false });
    assert.equal(await readFile(path, "utf8"), before);
    assert.equal((await lstat(path)).isSymbolicLink(), kind === "symlink");
    await absent(join(setup.codexHome, "hooks.json"));
    await absent(setup.targets.wrapperPath);
    assert.equal(setup.calls.filter(([command]) => command === "launchctl").length, 1);
  }
});

test("all three adapters merge without changing user hooks or disabled choices", async (t) => {
  const setup = await fixture(t);
  const path = join(setup.codexHome, "hooks.json");
  const original = {
    description: "My existing hooks",
    disabled: true,
    hooks: {
      Stop: [{ matcher: "", disabled: true, hooks: [{ type: "command", command: "printf user-hook", async: false, disabled: true }] }],
      PostToolUse: [{ hooks: [{ type: "mcp_tool", server: "local", tool: "record" }] }],
    },
  };
  await writeConfig(path, original);
  const options = { ...setup, adapters: ["claude", "opencode", "codex"] };
  await bootstrap(options);
  const first = JSON.parse(await readFile(path, "utf8"));
  assert.equal(first.description, original.description);
  assert.equal(first.disabled, true);
  assert.deepEqual(first.hooks.Stop[0], original.hooks.Stop[0]);
  assert.deepEqual(first.hooks.PostToolUse[0], original.hooks.PostToolUse[0]);
  const command = plan.codexHookCommand(setup.targets);
  const managedStop = first.hooks.Stop.find((group) => group.hooks.some((hook) => hook.command === command));
  managedStop.hooks[0].disabled = true;
  await writeConfig(path, first);
  const beforeSecond = await readFile(path, "utf8");
  const second = await bootstrap(options);
  assert.equal(second.changed.codexHooks, false);
  assert.equal(await readFile(path, "utf8"), beforeSecond);
  assert.deepEqual(JSON.parse(await readFile(`${path}.compass.bak`, "utf8")), original);
  assert.equal((await stat(`${path}.compass.bak`)).mode & 0o777, 0o600);
  assert.ok(await stat(setup.targets.claudeSettings));
  assert.ok(await stat(setup.targets.opencodeConfig));
});

test("Codex uninstall removes only owned commands after subsequent user edits", async (t) => {
  const setup = await fixture(t);
  const path = join(setup.codexHome, "hooks.json");
  const original = { description: "Keep this", hooks: { Stop: [{ hooks: [{ type: "command", command: "echo before" }] }] } };
  await writeConfig(path, original);
  await bootstrap({ ...setup, adapters: ["codex"] });
  const edited = JSON.parse(await readFile(path, "utf8"));
  edited.description = "User changed this after installation";
  edited.hooks.Stop[1].hooks.push({ type: "command", command: "echo added-to-managed-group" });
  edited.hooks.Stop.push({ matcher: "any", hooks: [{ type: "command", command: "echo added-later" }] });
  await writeConfig(path, edited);
  await uninstall({ ...setup, skipLaunchd: false });
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
    description: edited.description,
    hooks: { Stop: [original.hooks.Stop[0], { hooks: [{ type: "command", command: "echo added-to-managed-group" }] }, edited.hooks.Stop[2]] },
  });
  assert.equal(setup.calls.filter(([command]) => command === "launchctl").length, 1);
  assert.ok(await stat(setup.targets.keyFile));
  await absent(setup.targets.wrapperPath);
});

test("custom Codex homes are remembered for a later whole-harness uninstall", async (t) => {
  const setup = await fixture(t);
  const firstHome = join(setup.home, "codex-one");
  const secondHome = join(setup.home, "codex-two");
  await bootstrap({ ...setup, codexHome: firstHome, adapters: ["codex"] });
  await bootstrap({ ...setup, codexHome: secondHome, adapters: ["codex"] });
  const manifestPath = join(setup.targets.stateDir, "installation.json");
  const manifestBefore = JSON.parse(await readFile(manifestPath, "utf8"));
  await bootstrap(setup);
  const manifestAfter = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.deepEqual(manifestAfter.codex, manifestBefore.codex);
  assert.deepEqual(new Set(manifestAfter.adapters), new Set(["claude", "opencode", "codex"]));
  assert.equal((await stat(manifestPath)).mode & 0o777, 0o600);
  await uninstall(setup);
  for (const codexHome of [firstHome, secondHome]) {
    await absent(join(codexHome, "hooks.json"));
  }
  await absent(manifestPath);
});

test("reinstall unions selected adapters for whole-harness cleanup", async (t) => {
  const setup = await fixture(t);
  for (const adapter of ["claude", "opencode", "codex"]) {
    await bootstrap({ ...setup, adapters: [adapter] });
  }
  const manifest = JSON.parse(await readFile(setup.targets.installationManifest, "utf8"));
  assert.deepEqual(manifest.adapters, ["claude", "opencode", "codex"]);
  await uninstall(setup);
  await absent(setup.targets.claudeSettings);
  await absent(join(setup.codexHome, "hooks.json"));
  assert.deepEqual(JSON.parse(await readFile(setup.targets.opencodeConfig, "utf8")), {});
  await absent(setup.targets.zshenv);
  await absent(setup.targets.installationManifest);
});

test("uninstall refuses a missing manifest before removing a managed service or changing clients", async (t) => {
  for (const dryRun of [true, false]) {
    const setup = await fixture(t);
    await bootstrap({ ...setup, adapters: ["claude", "opencode", "codex"] });
    const paths = [setup.targets.claudeSettings, setup.targets.opencodeConfig,
      setup.targets.zshenv, setup.targets.codexHooks, setup.targets.wrapperPath,
      setup.targets.plistPath, setup.targets.keyFile];
    const originals = await Promise.all(paths.map((path) => readFile(path)));
    await rm(setup.targets.installationManifest);
    const calls = [...setup.calls];
    await assert.rejects(uninstall({ ...setup, dryRun, purgeState: true, skipLaunchd: false }), /installation manifest is missing/i);
    assert.deepEqual(await Promise.all(paths.map((path) => readFile(path))), originals);
    assert.deepEqual(setup.calls, calls);
  }
});

test("invalid adapter selections fail before files or commands are touched", async (t) => {
  for (const adapters of [[], ["unknown"], ["codex", "codex"], "codex", [null], ["codex", ""]]) {
    const setup = await fixture(t);
    await assert.rejects(bootstrap({ ...setup, adapters }), /adapter/i);
    assert.deepEqual(await readdir(setup.home), []);
    assert.deepEqual(setup.calls, []);
  }
});

test("uninstall merges registrations for macOS aliases of the same Codex home", async (t) => {
  const setup = await fixture(t);
  const path = join(setup.codexHome, "hooks.json");
  const original = { description: "preserved", hooks: { Stop: [{ hooks: [{ type: "command", command: "echo user-owned" }] }] } };
  await writeConfig(path, original);
  await bootstrap({ ...setup, adapters: ["codex"] });
  await bootstrap({ ...setup, adapters: ["codex"], codexHome: await realpath(setup.codexHome) });
  await uninstall(setup);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), original);
});

test("Codex-only dry run reports selection and custom home without writing", async (t) => {
  const setup = await fixture(t);
  const result = await bootstrap({ ...setup, adapters: ["codex"], dryRun: true });
  assert.deepEqual(result.plan.adapters, ["codex"]);
  assert.equal(result.plan.targets.codexHooks, join(setup.codexHome, "hooks.json"));
  assert.deepEqual(await readdir(setup.home), []);
  assert.deepEqual(setup.calls, []);
});

for (const command of ["bootstrap", "uninstall"]) {
  test(`${command} CLI dry run prints one JSON plan without filesystem writes`, async (t) => {
    const setup = await fixture(t);
    const args = [fileURLToPath(new URL(`../../install/${command}.mjs`, import.meta.url)), "--home", setup.home, "--codex-home", setup.codexHome, "--dry-run", "--skip-launchd"];
    if (command === "bootstrap") args.push("--adapters", "codex", "--skip-runtime");
    const result = await execFileAsync(process.execPath, args);
    assert.notEqual(result.stdout.trim(), "", "dry-run plan must be visible on stdout");
    assert.equal(result.stdout.trim().split("\n").length, 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.dryRun, true);
    assert.equal(output.plan.targets.keyFile, setup.targets.keyFile);
    assert.equal(typeof output.plan, "object");
    assert.equal(result.stderr, "");
    assert.deepEqual(await readdir(setup.home), []);
  });
}

test("CLI accepts adapter selection and Codex home, rejects duplicate or unknown flags", async (t) => {
  const setup = await fixture(t);
  const entry = new URL("../../install/bootstrap.mjs", import.meta.url);
  await execFileAsync(process.execPath, [fileURLToPath(entry), "--home", setup.home, "--codex-home", setup.codexHome, "--adapters", "codex", "--skip-runtime", "--skip-launchd"], { env: { ...process.env, CODEX_HOME: join(setup.home, "ignored-env-home") } });
  assert.ok(await stat(join(setup.codexHome, "hooks.json")));
  await absent(join(setup.home, "ignored-env-home"));
  await absent(setup.targets.claudeSettings);
  const invalid = [
    ["--adapters", "codex,codex"], ["--adapters", "codex,"], ["--adapters", "unknown"],
    ["--adapters", "codex", "--adapters", "claude"], ["--codex-home"], ["--unknown"],
    ["--dry-run", "--dry-run"],
  ];
  for (const args of invalid) {
    await assert.rejects(execFileAsync(process.execPath, [fileURLToPath(entry), "--home", setup.home, ...args]));
  }
});

test("CLI honors CODEX_HOME when no explicit Codex home is supplied", async (t) => {
  const setup = await fixture(t);
  const envHome = join(setup.home, "env-codex");
  await execFileAsync(process.execPath, [fileURLToPath(new URL("../../install/bootstrap.mjs", import.meta.url)), "--home", setup.home, "--adapters", "codex", "--skip-runtime", "--skip-launchd"], { env: { ...process.env, CODEX_HOME: envHome } });
  assert.ok(await stat(join(envHome, "hooks.json")));
  await absent(join(setup.codexHome, "hooks.json"));
  await execFileAsync(process.execPath, [fileURLToPath(new URL("../../install/uninstall.mjs", import.meta.url)), "--home", setup.home, "--codex-home", setup.codexHome, "--skip-launchd"]);
  await absent(join(envHome, "hooks.json"));
});

test("Codex transforms reject malformed root, group, and handler shapes", () => {
  assert.equal(typeof plan.mergeCodexHooks, "function");
  assert.equal(typeof plan.removeCodexHooks, "function");
  const targets = plan.resolveTargets({ home: "/Users/example", repoRoot: "/repo/project" });
  for (const invalid of [[], true, "text", { hooks: [] }, { hooks: null }, { hooks: { Stop: {} } }, { hooks: { Stop: [null] } }, { hooks: { Stop: [{ hooks: {} }] } }, { hooks: { Stop: [{ hooks: [null] }] } }, { hooks: { Stop: [{ hooks: [{ type: "command", command: 1 }] }] } }]) {
    assert.throws(() => plan.mergeCodexHooks(invalid, targets), /Codex/);
    assert.throws(() => plan.removeCodexHooks(invalid, targets), /Codex/);
  }
});
