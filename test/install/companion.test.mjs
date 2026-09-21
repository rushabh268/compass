import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { renderSupervisorWrapper, resolveTargets } from "../../install/plan.mjs";
import { request } from "../../src/supervisor/client.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(await realpath("/tmp"), "cp-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const targets = resolveTargets({ home, repoRoot: resolve(".") });
  await mkdir(targets.stateDir, { recursive: true, mode: 0o700 });
  await mkdir(dirname(targets.runtimeNodeBin), { recursive: true });
  // Fixed fixture forwarding executable; provisioning must not install a runtime.
  await writeFile(targets.runtimeNodeBin, `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o755 });
  await writeFile(targets.keyFile, Buffer.alloc(32, 1), { mode: 0o600 });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(COMPASS_|AGENT_HARNESS_)/.test(key)));
  env.HOME = home; env.CODEX_HOME = join(home, ".codex");
  return { root, home, targets, env };
}

async function startWrapper(t, setup) {
  const child = spawn("/bin/sh", [setup.targets.wrapperPath], { env: setup.env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.stdout.resume();
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await exited;
  });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      await request({ socketPath: setup.targets.socket, authKey: Buffer.alloc(32, 1), method: "health", params: {}, timeoutMs: 200 });
      return;
    } catch {
      if (child.exitCode !== null) throw new Error(`fixture supervisor failed: ${stderr}`);
      await delay(20);
    }
  }
  throw new Error(`fixture supervisor did not become ready: ${stderr}`);
}

test("installed wrapper accepts an optional separately provisioned reader credential", async t => {
  const setup = await fixture(t);
  await mkdir(dirname(setup.targets.wrapperPath), { recursive: true });
  await writeFile(setup.targets.wrapperPath, renderSupervisorWrapper(setup.targets), { mode: 0o755 });
  await writeFile(join(setup.targets.stateDir, "reader.key"), Buffer.alloc(32, 2), { mode: 0o600 });
  await startWrapper(t, setup);
  assert.deepEqual(await request({ socketPath: setup.targets.socket, authKey: Buffer.alloc(32, 2), method: "health", params: {} }),
    { ok: true, capabilities: { sessionEvidence: 1, readerRole: true } });
});

async function enable(setup) {
  const { enableCompanion } = await import("../../install/companion.mjs");
  return enableCompanion({ home: setup.home, stateDir: setup.targets.stateDir });
}

async function nativeSentinels(setup) {
  const paths = [".claude/settings.json", ".codex/config.toml", ".config/opencode/opencode.jsonc", ".zshenv", "AGENTS.md", "CLAUDE.md"];
  for (const name of paths) {
    const path = join(setup.home, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `untouched native sentinel: ${name}\n`);
  }
  return async () => {
    for (const name of paths) assert.equal(await readFile(join(setup.home, name), "utf8"), `untouched native sentinel: ${name}\n`);
  };
}

test("companion enable upgrades an installed wrapper, preserves keys and native registrations, and is idempotent", async t => {
  const setup = await fixture(t);
  const checkNative = await nativeSentinels(setup);
  const { renderLaunchdPlist } = await import("../../install/plan.mjs");
  await mkdir(dirname(setup.targets.wrapperPath), { recursive: true });
  await mkdir(dirname(setup.targets.plistPath), { recursive: true });
  await writeFile(setup.targets.wrapperPath, renderSupervisorWrapper(setup.targets, { legacy: true }), { mode: 0o755 });
  await writeFile(setup.targets.plistPath, renderLaunchdPlist(setup.targets));
  const manifest = '{"schemaVersion":1,"adapters":["claude","opencode"],"codex":[]}\n';
  await writeFile(setup.targets.installationManifest, manifest, { mode: 0o600 });
  const first = await enable(setup);
  assert.equal(first.reloadRequired, true);
  const key = await readFile(first.readerKeyFile);
  assert.equal(key.length, 32);
  const second = await enable(setup);
  assert.equal(second.reloadRequired, false);
  assert.deepEqual(await readFile(second.readerKeyFile), key);
  assert.deepEqual(await readFile(setup.targets.keyFile), Buffer.alloc(32, 1));
  assert.equal(await readFile(setup.targets.installationManifest, "utf8"), manifest);
  await checkNative();
  await assert.rejects(readFile(setup.targets.socket), { code: "ENOENT" });
  await startWrapper(t, setup);
  assert.equal((await request({ socketPath: setup.targets.socket, authKey: key, method: "health", params: {} })).capabilities.readerRole, true);
  assert.deepEqual(await request({ socketPath: setup.targets.socket, authKey: Buffer.alloc(32, 1), method: "health", params: {} }), { ok: true });
  await checkNative();
});

for (const artifact of ["wrapperPath", "plistPath"]) {
  test(`custom ${artifact} is refused before key or service mutation`, async t => {
    const setup = await fixture(t);
    await mkdir(dirname(setup.targets[artifact]), { recursive: true });
    await writeFile(setup.targets[artifact], "custom service\n");
    await assert.rejects(enable(setup), /custom Compass/);
    assert.equal(await readFile(setup.targets[artifact], "utf8"), "custom service\n");
    await assert.rejects(readFile(join(setup.targets.stateDir, "reader.key")), { code: "ENOENT" });
    const other = artifact === "plistPath" ? "wrapperPath" : "plistPath";
    await assert.rejects(readFile(setup.targets[other]), { code: "ENOENT" });
  });
}

test("symlink service target is refused before provisioning", async t => {
  const setup = await fixture(t);
  const { symlink } = await import("node:fs/promises");
  const outside = join(setup.root, "outside");
  await writeFile(outside, "untouched");
  await mkdir(dirname(setup.targets.wrapperPath), { recursive: true });
  await symlink(outside, setup.targets.wrapperPath);
  await assert.rejects(enable(setup), /symlink/);
  assert.equal(await readFile(outside, "utf8"), "untouched");
  await assert.rejects(readFile(join(setup.targets.stateDir, "reader.key")), { code: "ENOENT" });
});

test("reader state is retained on normal uninstall and removed only with explicit state purge", { skip: process.platform !== "darwin" }, async t => {
  const setup = await fixture(t);
  const checkNative = await nativeSentinels(setup);
  // This fixture has no registered adapters. Record that ownership explicitly;
  // absence of a manifest cannot establish that real client hooks are absent.
  await writeFile(setup.targets.installationManifest,
    '{"schemaVersion":1,"adapters":[],"codex":[]}\n', { mode: 0o600 });
  const result = await enable(setup);
  const { run: uninstall } = await import("../../install/uninstall.mjs");
  const options = { home: setup.home, stateDir: setup.targets.stateDir, skipLaunchd: true };
  const key = await readFile(result.readerKeyFile);
  await uninstall(options);
  assert.deepEqual(await readFile(result.readerKeyFile), key);
  await assert.rejects(readFile(setup.targets.wrapperPath), { code: "ENOENT" });
  await checkNative();
  await uninstall({ ...options, purgeState: true });
  await assert.rejects(readFile(result.readerKeyFile), { code: "ENOENT" });
  await checkNative();
});

test("companion CLI requires explicit paths and prepares service without starting it", async t => {
  const setup = await fixture(t);
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  await assert.rejects(exec(process.execPath, ["src/cli.mjs", "companion-enable"], { env: setup.env }), /requires --home and --state-dir/);
  const { stdout } = await exec(process.execPath, ["src/cli.mjs", "companion-enable", "--home", setup.home, "--state-dir", setup.targets.stateDir], { env: setup.env });
  assert.equal(JSON.parse(stdout).reloadRequired, true);
  await assert.rejects(readFile(setup.targets.socket), { code: "ENOENT" });
});
