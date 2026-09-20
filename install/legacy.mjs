import { join } from "node:path";
import { fileText, inspectPath } from "./files.mjs";
import { parseJsonc } from "./plan.mjs";

function rejectLegacy(path) {
  throw new Error(`Legacy Agent Harness installation detected at ${path}; use its original checkout's uninstall.sh without --purge-state before installing Compass. Keep the original auth key and ledger together. See docs/migration.md.`);
}

// Guard recognizable managed installations before bootstrap writes anything.
// Retained keys, ledger, and runtime alone are intentionally not a collision:
// the original uninstaller preserves them for explicit operator-led migration.
export async function assertNoLegacyInstallation({ home, targets, adapters }) {
  for (const path of [
    join(home, "Library/LaunchAgents/local.agent-harness.plist"),
    join(home, ".local/bin/agent-harness-supervisor"),
    join(home, ".local/state/agent-harness/installation.json"),
  ]) {
    if ((await inspectPath(path)).entry) rejectLegacy(path);
  }
  for (const [adapter, path] of [["claude", targets.claudeSettings], ["codex", targets.codexHooks]]) {
    if (!adapters.includes(adapter)) continue;
    const text = await fileText(path);
    if (text === null) continue;
    const settings = JSON.parse(text);
    for (const groups of Object.values(settings?.hooks ?? {})) {
      if (!Array.isArray(groups)) continue; // Normal client preflight validates shape.
      for (const group of groups) {
        if (!Array.isArray(group?.hooks)) continue;
        for (const hook of group.hooks) {
          if (hook?.type === "command" && typeof hook.command === "string" &&
              /(?:^|\s)AGENT_HARNESS_(?:SOCKET|KEY_FILE)=/.test(hook.command)) rejectLegacy(path);
        }
      }
    }
  }
  if (adapters.includes("opencode")) {
    const shell = await fileText(targets.zshenv);
    if (/^# BEGIN agent-harness\r?$/m.test(shell ?? "")) rejectLegacy(targets.zshenv);
    const text = await fileText(targets.opencodeConfig);
    if (text !== null) {
      const config = parseJsonc(text);
      if (Array.isArray(config.plugin) && config.plugin.some((plugin) => {
        if (typeof plugin !== "string" || !plugin.startsWith("file:")) return false;
        try { return /\/agent-harness\/adapters\/opencode\/server\.js$/.test(decodeURIComponent(new URL(plugin).pathname)); }
        catch { return false; }
      })) rejectLegacy(targets.opencodeConfig);
    }
  }
}
