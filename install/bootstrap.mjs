import { assertNoLegacyInstallation } from "./legacy.mjs";
import { spawn } from "node:child_process";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { readAuthKeyFile } from "../src/paths.mjs";
import { assertSupportedRuntime } from "../src/runtime.mjs";
import {
  DEFAULT_ADAPTERS, applyZshenv, codexGroundingHookCommand, codexHookCommand, generateKey,
  insertOpenCodePlugin, mergeClaudeSettings, mergeCodexHooks,
  renderCoalescingConfig, renderGroundingConfig, renderLaunchdPlist,
  renderSupervisorWrapper, resolveTargets, validateAdapters,
} from "./plan.mjs";
import {
  backupBeforeEdit, createIfAbsent, ensureDirectory, fileText, inspectPath,
  preflightDirectory, preflightEdit, preflightFile, writeIfDifferent,
} from "./files.mjs";
import { addCodexRegistration, parseManifest } from "./manifest.mjs";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const RUNTIME_VERSION = "24.19.0";

function commandRunner(command, args, options = {}) {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolveCommand({ code, stdout, stderr }));
  });
}

function assertCommandSucceeded(result, command) {
  if (result?.code !== undefined && result.code !== 0) {
    throw new Error(`${command} failed with exit code ${result.code}: ${result.stderr ?? ""}`.trim());
  }
}

async function installedNodeVersion(path, runCommand) {
  if (!(await inspectPath(path)).entry) return null;
  const result = await runCommand(path, ["--version"]);
  return result.code === 0 ? result.stdout.trim().replace(/^v/, "") : null;
}

function parseArgs(args) {
  const options = {};
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (seen.has(argument)) throw new Error(`duplicate option: ${argument}`);
    seen.add(argument);
    const key = argument.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (["--home", "--codex-home", "--adapters"].includes(argument)) {
      if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${argument} requires a value`);
      options[key] = argument === "--adapters" ? args[index + 1].split(",") : args[index + 1];
      index += 1;
    } else if (["--dry-run", "--skip-runtime", "--skip-launchd"].includes(argument)) {
      options[key] = true;
    } else throw new Error(`unknown option: ${argument}`);
  }
  return options;
}

function parseSettings(text, client) {
  if (text === null) return null;
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${client} settings must be an object`);
  return value;
}

async function clientEdits(targets, adapters) {
  const edits = [];
  for (const [adapter, key, transform] of [
    ["claude", "claudeSettings", (text) => mergeClaudeSettings(parseSettings(text, "Claude"), targets)],
    ["codex", "codexHooks", (text) => mergeCodexHooks(parseSettings(text, "Codex"), targets)],
    ["opencode", "opencodeConfig", (text) => insertOpenCodePlugin(text, targets)],
    ["opencode", "zshenv", (text) => applyZshenv(text, targets)],
  ]) {
    if (!adapters.includes(adapter)) continue;
    const path = targets[key];
    const original = await fileText(path);
    const result = transform(original);
    const text = result.settings ? `${JSON.stringify(result.settings, null, 2)}\n` : result.text;
    const edit = { key, path, original, text, changed: result.changed };
    await preflightEdit(edit);
    edits.push(edit);
  }
  return edits;
}

async function validateKey(path) {
  const checked = await preflightFile(path, { mode: 0o600 });
  if (checked.entry) {
    const key = await readAuthKeyFile(checked.path);
    key.fill(0);
  }
}

export async function run({
  home = os.homedir(),
  repoRoot = repositoryRoot,
  codexHome = process.env.CODEX_HOME || join(home, ".codex"),
  adapters = DEFAULT_ADAPTERS,
  runCommand = commandRunner,
  dryRun = false,
  skipRuntime = false,
  skipLaunchd = false,
  now = new Date(),
} = {}) {
  if (process.platform !== "darwin") throw new Error("compass bootstrap requires macOS");
  assertSupportedRuntime();
  adapters = validateAdapters(adapters);
  const targets = resolveTargets({ home, repoRoot, codexHome });
  await assertNoLegacyInstallation({ home, targets, adapters });
  const runtimeDir = dirname(dirname(dirname(dirname(targets.runtimeNodeBin))));
  const packagePath = join(runtimeDir, "package.json");

  // Transform and validate every selected client before creating state, installing
  // the runtime, or restarting the shared supervisor.
  const edits = await clientEdits(targets, adapters);
  await preflightDirectory(targets.stateDir, { mode: 0o700 });
  await validateKey(targets.keyFile);
  await inspectPath(targets.socket, { socket: true });
  for (const path of [targets.coalescingConfig, targets.groundingConfig]) await preflightFile(path);
  for (const path of [targets.wrapperPath, targets.plistPath]) await preflightFile(path, { writable: true });
  for (const path of [targets.ledger, targets.outLog, targets.errLog]) await preflightFile(path, { writable: true });
  if (!skipRuntime) {
    await preflightDirectory(runtimeDir);
    await preflightFile(packagePath, { writable: true });
    await preflightFile(targets.runtimeNodeBin);
  }
  const manifestOriginal = await fileText(targets.installationManifest, { mode: 0o600, maxBytes: 1024 * 1024 });
  let manifest = parseManifest(manifestOriginal);
  manifest.adapters = [...new Set([...manifest.adapters, ...adapters])];
  if (adapters.includes("codex")) {
    const path = (await inspectPath(targets.codexHooks)).path;
    for (const command of [codexHookCommand(targets), codexGroundingHookCommand(targets)]) {
      manifest = addCodexRegistration(manifest, path, command);
    }
  }
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestChanged = manifestText !== manifestOriginal;
  await preflightFile(targets.installationManifest, { writable: manifestChanged, mode: 0o600 });

  const plan = { generatedAt: now.toISOString(), targets, adapters, runtime: !skipRuntime, launchd: !skipLaunchd };
  if (dryRun) return { dryRun: true, plan };

  const changed = { runtimePackage: false, runtime: false, claudeSettings: false, opencodeConfig: false, codexHooks: false, zshenv: false };
  if (!skipRuntime) {
    await ensureDirectory(runtimeDir);
    changed.runtimePackage = await writeIfDifferent(packagePath, `${JSON.stringify({ dependencies: { node: RUNTIME_VERSION } }, null, 2)}\n`, 0o600);
    if (await installedNodeVersion(targets.runtimeNodeBin, runCommand) !== RUNTIME_VERSION) {
      assertCommandSucceeded(await runCommand("npm", ["install", "--prefix", runtimeDir, `node@${RUNTIME_VERSION}`]), "npm install");
      changed.runtime = true;
    }
  }

  changed.stateDir = await ensureDirectory(targets.stateDir, { exactMode: true });
  const key = generateKey();
  try {
    changed.keyFile = await createIfAbsent(targets.keyFile, key);
  } finally {
    key.fill(0);
  }
  await validateKey(targets.keyFile);
  changed.coalescingConfig = await createIfAbsent(targets.coalescingConfig, renderCoalescingConfig());
  changed.groundingConfig = await createIfAbsent(targets.groundingConfig, renderGroundingConfig());
  changed.wrapper = await writeIfDifferent(targets.wrapperPath, renderSupervisorWrapper(targets), 0o755);
  changed.plist = await writeIfDifferent(targets.plistPath, renderLaunchdPlist(targets), 0o644);
  // Record selected clients before writing their registrations. Uninstall then
  // avoids unrelated configs and can find Codex homes after CODEX_HOME changes.
  changed.installationManifest = manifestChanged
    ? await writeIfDifferent(targets.installationManifest, manifestText, 0o600, manifestOriginal)
    : false;
  for (const edit of edits) {
    await backupBeforeEdit(edit);
    if (edit.changed) await writeIfDifferent(edit.path, edit.text, 0o600, edit.original);
    changed[edit.key] = edit.changed;
  }

  if (!skipLaunchd) {
    try {
      await runCommand("launchctl", ["bootout", `gui/${process.getuid()}`, targets.plistPath]);
    } catch {
      // A previous bootstrap may not have loaded this plist yet.
    }
    assertCommandSucceeded(await runCommand("launchctl", ["bootstrap", `gui/${process.getuid()}`, targets.plistPath]), "launchctl bootstrap");
  }
  return { dryRun: false, targets, adapters, changed };
}

export async function main() {
  const result = await run(parseArgs(process.argv.slice(2)));
  if (result.dryRun) process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
