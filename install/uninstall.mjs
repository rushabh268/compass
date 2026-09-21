import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assertSupportedRuntime } from "../src/runtime.mjs";
import { removeClaudeSettings, removeCodexHooks, removeOpenCodePlugin, removeZshenv, resolveTargets } from "./plan.mjs";
import { fileText, inspectPath, preflightDirectory, preflightFile, removeFile, writeIfDifferent } from "./files.mjs";
import { parseManifest } from "./manifest.mjs";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

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

function parseArgs(args) {
  const options = {};
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (seen.has(argument)) throw new Error(`duplicate option: ${argument}`);
    seen.add(argument);
    const key = argument.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (["--home", "--codex-home", "--state-dir"].includes(argument)) {
      if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${argument} requires a value`);
      options[key] = args[++index];
    } else if (["--dry-run", "--purge-state", "--skip-launchd"].includes(argument)) options[key] = true;
    else throw new Error(`unknown option: ${argument}`);
  }
  return options;
}

function parseSettings(text, client) {
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${client} settings must be an object`);
  return value;
}

async function removalEdit(path, transform) {
  const original = await fileText(path);
  if (original === null) return null;
  const result = transform(original);
  const text = result.settings ? `${JSON.stringify(result.settings, null, 2)}\n` : result.text;
  await preflightFile(path, { writable: result.changed });
  const backups = await Promise.all([`${path}.compass.bak`, `${path}.agent-harness.bak`].map((backup) => inspectPath(backup)));
  return { path, original, text, changed: result.changed, remove: !backups.some((backup) => backup.entry) && (text === "" || text === "{}\n") };
}

export async function run({
  home = os.homedir(),
  repoRoot = repositoryRoot,
  stateDir,
  codexHome = process.env.CODEX_HOME || join(home, ".codex"),
  runCommand = commandRunner,
  dryRun = false,
  purgeState = false,
  skipLaunchd = false,
} = {}) {
  if (process.platform !== "darwin") throw new Error("compass uninstall requires macOS");
  assertSupportedRuntime();
  const targets = resolveTargets({ home, repoRoot, codexHome, stateDir });
  await preflightDirectory(targets.stateDir, { mode: 0o700 });
  const manifestText = await fileText(targets.installationManifest, { mode: 0o600, maxBytes: 1024 * 1024 });
  if (manifestText === null) {
    for (const path of [targets.plistPath, targets.wrapperPath]) {
      if ((await inspectPath(path)).entry) {
        throw new Error("installation manifest is missing; restore its recorded client registrations before uninstalling the managed service");
      }
    }
  }
  const manifest = parseManifest(manifestText);
  const codexCommands = new Map();
  for (const registration of manifest.codex) {
    const { path } = await inspectPath(registration.path);
    const commands = codexCommands.get(path) ?? [];
    if (!commands.includes(registration.command)) commands.push(registration.command);
    codexCommands.set(path, commands);
  }

  // All removals are preflighted before editing any client or stopping the common
  // service. Backups are never restored over subsequent user changes.
  const edits = [];
  if (manifest.adapters.includes("claude")) {
    edits.push(await removalEdit(targets.claudeSettings, (text) => removeClaudeSettings(parseSettings(text, "Claude"), targets)));
  }
  if (manifest.adapters.includes("opencode")) {
    edits.push(await removalEdit(targets.opencodeConfig, (text) => removeOpenCodePlugin(text, targets)));
    edits.push(await removalEdit(targets.zshenv, removeZshenv));
  }
  for (const [path, commands] of codexCommands) {
    edits.push(await removalEdit(path, (text) => removeCodexHooks(parseSettings(text, "Codex"), targets, commands)));
  }
  for (const path of [targets.plistPath, targets.wrapperPath, targets.installationManifest]) await preflightFile(path, { writable: true });
  const plan = { targets, adapters: manifest.adapters, purgeState, launchd: !skipLaunchd, codexHooks: [...codexCommands.keys()] };
  if (dryRun) return { dryRun: true, plan };

  for (const edit of edits) {
    if (!edit?.changed) continue;
    if (edit.remove) await removeFile(edit.path, edit.original);
    else await writeIfDifferent(edit.path, edit.text, 0o600, edit.original);
  }
  await removeFile(targets.installationManifest, manifestText);
  if (!skipLaunchd) {
    try {
      await runCommand("launchctl", ["bootout", `gui/${process.getuid()}`, targets.plistPath]);
    } catch {
      // The launch agent may already be unloaded.
    }
  }
  await removeFile(targets.plistPath);
  await removeFile(targets.wrapperPath);
  if (purgeState) {
    const checked = await preflightDirectory(targets.stateDir, { mode: 0o700 });
    await rm(checked.path, { recursive: true, force: true });
  }
  return { dryRun: false, targets, purgeState };
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
