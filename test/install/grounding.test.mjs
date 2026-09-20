import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import * as plan from "../../install/plan.mjs";
import { run as bootstrap } from "../../install/bootstrap.mjs";
import { run as uninstall } from "../../install/uninstall.mjs";

const exec = promisify(execFile);
const events = ["SessionStart", "UserPromptSubmit", "SubagentStart"];
const handlers = (settings, command) => Object.entries(settings.hooks ?? {}).flatMap(([event, groups]) =>
  groups.flatMap((group) => group.hooks.filter((hook) => hook.command === command).map((hook) => ({ event, hook }))));
async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), "harness-grounding-install-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  return { home, repoRoot: join(home, "repository"), codexHome: join(home, "codex"), skipRuntime: true, skipLaunchd: true,
    runCommand: async () => { throw new Error("no external installer commands allowed"); } };
}
async function writeJSON(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
}

for (const platform of ["claude", "codex"]) {
  const merge = platform === "claude" ? plan.mergeClaudeSettings : plan.mergeCodexHooks;
  const remove = platform === "claude" ? plan.removeClaudeSettings : plan.removeCodexHooks;
  test(`${platform} upgrades telemetry with separate synchronous grounding and preserves disabled choices`, () => {
    const targets = plan.resolveTargets({ home: "/temporary/home", repoRoot: "/temporary/repo" });
    const telemetryCommand = plan[`${platform}HookCommand`](targets);
    const original = { disabled: true, trust: "user-choice", hooks: { SessionStart: [{ disabled: true, hooks: [
      { type: "command", command: telemetryCommand, disabled: true, async: false },
      { type: "command", command: "echo user-hook" },
    ] }] } };
    const first = merge(original, targets);
    const groundingCommand = plan[`${platform}GroundingHookCommand`](targets);
    assert.deepEqual(first.settings.hooks.SessionStart[0], original.hooks.SessionStart[0]);
    assert.equal(first.settings.disabled, true);
    assert.equal(first.settings.trust, "user-choice");
    assert.deepEqual(handlers(first.settings, groundingCommand).map(({ event }) => event).sort(), [...events].sort());
    for (const { hook } of handlers(first.settings, groundingCommand)) {
      assert.deepEqual(hook, { type: "command", command: groundingCommand, timeout: 3, ...(platform === "codex" ? { additionalContextLimit: 0 } : {}) });
      hook.disabled = true;
    }
    const second = merge(first.settings, targets);
    assert.equal(second.changed, false);
    assert.deepEqual(second.settings, first.settings);
    const removed = remove(second.settings, targets);
    assert.deepEqual(removed.settings, { disabled: true, trust: "user-choice", hooks: { SessionStart: [{ disabled: true, hooks: [{ type: "command", command: "echo user-hook" }] }] } });
    assert.equal(remove(removed.settings, targets).changed, false);
  });

  test(`${platform} grounding command quotes explicit custom config/state and inherits notes literally`, async (t) => {
    const setup = await fixture(t);
    const punctuation = "a space ' $literal `literal` ; &";
    const targets = plan.resolveTargets({ home: setup.home, repoRoot: join(setup.home, punctuation), stateDir: join(setup.home, punctuation, "state"), codexHome: setup.codexHome });
    assert.equal(targets.groundingHook, join(targets.claudeHook, "../../..", "src/grounding-hook.mjs"));
    targets.runtimeNodeBin = process.execPath;
    await mkdir(dirname(targets.groundingHook), { recursive: true });
    await writeFile(targets.groundingHook, 'process.stdout.write(JSON.stringify({args:process.argv.slice(2),env:Object.fromEntries(Object.entries(process.env).filter(([key])=>key.startsWith("AGENT_HARNESS_")))}));');
    const result = await exec("/bin/sh", ["-c", plan[`${platform}GroundingHookCommand`](targets)], { env: { HOME: setup.home, CODEX_HOME: setup.codexHome, AGENT_HARNESS_NOTES_DIR: "relative notes ' $literal" } });
    assert.deepEqual(JSON.parse(result.stdout), { args: ["--platform", platform], env: {
      AGENT_HARNESS_SOCKET: targets.socket, AGENT_HARNESS_KEY_FILE: targets.keyFile,
      AGENT_HARNESS_GROUNDING_CONFIG: targets.groundingConfig, AGENT_HARNESS_STATE_DIR: targets.stateDir,
      AGENT_HARNESS_NOTES_DIR: "relative notes ' $literal",
    } });
  });
}

test("bootstrap records both Codex callbacks once per home and removes both after the current home changes", async (t) => {
  const setup = await fixture(t);
  for (const codexHome of [setup.codexHome, join(setup.home, "second codex")]) {
    const targets = plan.resolveTargets({ ...setup, codexHome });
    const telemetry = plan.codexHookCommand(targets);
    await writeJSON(targets.codexHooks, { trust: "keep", hooks: { SessionStart: [{ hooks: [{ type: "command", command: telemetry, disabled: true }] }] } });
    await bootstrap({ ...setup, codexHome, adapters: ["codex"] });
    const again = await bootstrap({ ...setup, codexHome, adapters: ["codex"] });
    assert.equal(again.changed.codexHooks, false);
    assert.equal(again.changed.installationManifest, false);
    const manifest = JSON.parse(await readFile(again.targets.installationManifest, "utf8"));
    const path = await realpath(targets.codexHooks);
    assert.deepEqual(manifest.codex.filter((entry) => entry.path === path).map((entry) => entry.command), [telemetry, plan.codexGroundingHookCommand(targets)]);
  }
  await uninstall({ ...setup, codexHome: join(setup.home, "third codex") });
  for (const codexHome of [setup.codexHome, join(setup.home, "second codex")]) {
    assert.deepEqual(JSON.parse(await readFile(join(codexHome, "hooks.json"), "utf8")), { trust: "keep" });
  }
});

for (const platform of ["claude", "codex"]) {
  test(`${platform}-only installed grounding callback reads fresh project notes without shell setup`, async (t) => {
    const setup = await fixture(t);
    const targets = plan.resolveTargets(setup);
    await cp(new URL("../../src/", import.meta.url), join(setup.repoRoot, "src"), { recursive: true });
    await mkdir(dirname(targets.runtimeNodeBin), { recursive: true });
    await symlink(process.execPath, targets.runtimeNodeBin);
    const project = join(setup.home, "project with spaces");
    const notes = join(project, "custom notes", "initiative");
    await mkdir(notes, { recursive: true });
    const env = { HOME: setup.home, CODEX_HOME: setup.codexHome, PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", AGENT_HARNESS_NOTES_DIR: "custom notes" };
    await exec("git", ["init", "-b", "grounding-fixture", project], { env });
    await exec("git", ["-C", project, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "fixture"], { env });
    await bootstrap({ ...setup, adapters: [platform] });
    await writeJSON(targets.groundingConfig, { schemaVersion: 1, enabled: true, tokenBudget: 512, deadlineMs: 800, sources: ["project-notes"] });
    const settings = JSON.parse(await readFile(platform === "claude" ? targets.claudeSettings : targets.codexHooks, "utf8"));
    const command = plan[`${platform}GroundingHookCommand`](targets);
    assert.equal(handlers(settings, command).length, 3);
    for (const [index, event] of events.entries()) {
      const marker = `Fresh project evidence revision ${index}`;
      await writeFile(join(notes, "overview.md"), `# Evidence\n${marker}\n`);
      const stdout = await new Promise((resolve, reject) => {
        const child = spawn("/bin/sh", ["-c", command], { env, stdio: ["pipe", "pipe", "pipe"] });
        let output = "";
        let errors = "";
        child.stdout.on("data", (chunk) => { output += chunk; });
        child.stderr.on("data", (chunk) => { errors += chunk; });
        child.on("error", reject);
        child.on("close", (code) => code === 0 && errors === "" ? resolve(output) : reject(new Error(`callback failed ${code}: ${errors}`)));
        child.stdin.end(JSON.stringify({ hook_event_name: event, cwd: project }));
      });
      const result = JSON.parse(stdout).hookSpecificOutput;
      assert.equal(result.hookEventName, event);
      assert.ok(result.additionalContext.includes(marker));
      assert.ok(Buffer.byteLength(result.additionalContext, "utf8") <= 8192);
    }
    await assert.rejects(readFile(targets.zshenv), { code: "ENOENT" });
  });
}
