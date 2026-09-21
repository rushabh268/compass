import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { run as bootstrap } from "../../install/bootstrap.mjs";

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), "compass-legacy-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  return { home, repoRoot: join(home, "compass"), calls: [] };
}
async function put(home, path, body) {
  const target = join(home, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, body, { mode: 0o600 });
}
async function snapshot(home) {
  const result = {};
  for (const path of await readdir(home, { recursive: true, withFileTypes: true })) {
    if (path.isFile()) result[join(path.parentPath, path.name)] = await readFile(join(path.parentPath, path.name), "utf8");
  }
  return result;
}
const artifacts = [
  ["Library/LaunchAgents/local.agent-harness.plist", "old plist"],
  ["Library/LaunchAgents/example.agent-harness.plist", "custom-label old plist"],
  [".local/bin/agent-harness-supervisor", "old wrapper"],
  [".local/state/agent-harness/installation.json", "{}"],
  [".zshenv", "# BEGIN agent-harness\nexport AGENT_HARNESS_SOCKET='/custom/supervisor.sock'\n# END agent-harness\n"],
  [".claude/settings.json", JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "AGENT_HARNESS_SOCKET='/custom/socket' node /custom/adapters/claude/hook.mjs" }] }] } })],
  [".config/opencode/opencode.jsonc", '{"plugin":["file:///custom/agent-harness/adapters/opencode/server.js"]}'],
];
for (const [path, body] of artifacts) {
  for (const dryRun of [true, false]) {
    test(`legacy ${path} prevents changes (dryRun=${dryRun})`, async (t) => {
      const value = await fixture(t);
      await put(value.home, path, body);
      const before = await snapshot(value.home);
      await assert.rejects(bootstrap({ ...value, dryRun, runCommand: async (...args) => value.calls.push(args) }), /legacy Agent Harness installation.*uninstall/i);
      assert.deepEqual(await snapshot(value.home), before);
      assert.deepEqual(value.calls, []);
    });
  }
}
test("legacy Codex command in custom home prevents fresh registrations", async (t) => {
  const value = await fixture(t);
  const codexHome = join(value.home, "custom-codex");
  await put(value.home, "custom-codex/hooks.json", JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "AGENT_HARNESS_KEY_FILE='/custom/key' node /custom/hook.mjs" }] }] } }));
  await assert.rejects(bootstrap({ ...value, codexHome, adapters: ["codex"], dryRun: true }), /legacy Agent Harness installation/i);
});
test("retained legacy ledger/runtime and incidental prose do not block Compass", async (t) => {
  const value = await fixture(t);
  await put(value.home, ".local/state/agent-harness/events.sqlite", "retained");
  await put(value.home, ".local/share/agent-harness-runtime/package.json", "{}");
  await put(value.home, "Library/LaunchAgents/example.other-agent.plist", "unrelated service");
  await put(value.home, ".claude/settings.json", JSON.stringify({ description: "an agent harness", hooks: {} }));
  const result = await bootstrap({ ...value, dryRun: true });
  assert.equal(result.plan.targets.stateDir, join(value.home, ".local/state/compass"));
});

test("legacy backup preserves an originally present empty client config on uninstall", async (t) => {
  const value = await fixture(t);
  await put(value.home, ".claude/settings.json", "{}\n");
  await bootstrap({ ...value, adapters: ["claude"], skipRuntime: true, skipLaunchd: true });
  await put(value.home, ".claude/settings.json.agent-harness.bak", "{}\n");
  await rm(join(value.home, ".claude/settings.json.compass.bak"));
  const { run: uninstall } = await import("../../install/uninstall.mjs");
  await uninstall({ ...value, skipLaunchd: true });
  assert.equal(await readFile(join(value.home, ".claude/settings.json"), "utf8"), "{}\n");
});
