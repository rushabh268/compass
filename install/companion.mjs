import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { provisionReaderKey, readAuthKeyFile } from "../src/paths.mjs";
import { assertSupportedRuntime } from "../src/runtime.mjs";
import { fileText, inspectPath, preflightDirectory, preflightFile, writeIfDifferent } from "./files.mjs";
import { renderLaunchdPlist, renderSupervisorWrapper, resolveTargets } from "./plan.mjs";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** Prepare the existing Compass service for reader access without entering native bootstrap. */
export async function enableCompanion({ home, stateDir, runtimeDir, repoRoot = repositoryRoot } = {}) {
  assertSupportedRuntime();
  if (!home || !stateDir) throw new Error("companion-enable requires explicit home and stateDir");
  const targets = resolveTargets({ home, stateDir, runtimeDir, repoRoot });
  await preflightDirectory(home);
  const state = await preflightDirectory(stateDir, { mode: 0o700 });
  if (!state.entry) throw new Error("existing Compass state and writer credential are required");
  const writerKey = await readAuthKeyFile(targets.keyFile);
  writerKey.fill(0);
  const runtime = await inspectPath(targets.runtimeNodeBin);
  if (!runtime.entry || !(runtime.entry.mode & 0o111)) throw new Error("existing executable Compass runtime is required");
  const readerKeyFile = `${state.path}/reader.key`;
  const reader = await preflightFile(readerKeyFile, { mode: 0o600 });
  if (reader.entry) {
    const key = await readAuthKeyFile(readerKeyFile);
    key.fill(0);
  }

  // Every path and existing byte sequence is checked before provisioning a key
  // or changing service files. Custom service configurations are never replaced.
  const wrapper = renderSupervisorWrapper(targets);
  const plist = renderLaunchdPlist(targets);
  const edits = [];
  for (const [path, content, mode, recognized] of [
    [targets.wrapperPath, wrapper, 0o755, [wrapper, renderSupervisorWrapper(targets, { legacy: true })]],
    [targets.plistPath, plist, 0o644, [plist]],
  ]) {
    await preflightDirectory(dirname(path));
    await preflightFile(path, { writable: true });
    const original = await fileText(path);
    if (original !== null && !recognized.includes(original)) throw new Error("custom Compass service configuration requires a manual update");
    edits.push({ path, content, mode, original });
  }

  await provisionReaderKey(state.path);
  let changed = !reader.entry;
  for (const edit of edits) changed = await writeIfDifferent(edit.path, edit.content, edit.mode, edit.original) || changed;
  return {
    readerKeyFile,
    wrapperPath: targets.wrapperPath,
    plistPath: targets.plistPath,
    reloadRequired: changed,
    nextStep: changed ? "Explicitly reload the Compass LaunchAgent to activate the reader; no service was started or restarted." : "Configuration unchanged. Reload Compass if this reader configuration has not yet been activated.",
  };
}
