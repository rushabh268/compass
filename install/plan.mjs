import { randomBytes } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

export const CLAUDE_HOOK_EVENTS = [
  "SessionStart",
  "PostCompact",
  "PostToolUse",
  "SessionEnd",
  "UserPromptSubmit",
  "Stop",
  "StopFailure",
  "PostToolUseFailure",
  "PermissionRequest",
  "PreToolUse",
  "Notification",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "ConfigChange",
  "TaskCompleted",
  "TeammateIdle",
];

export const CODEX_HOOK_EVENTS = [
  "SessionStart", "SessionEnd", "SubagentStart", "SubagentStop", "PreToolUse",
  "PermissionRequest", "PostToolUse", "PreCompact", "PostCompact",
  "UserPromptSubmit", "Stop", "Interrupt",
];

export const GROUNDING_HOOK_EVENTS = Object.freeze(["SessionStart", "UserPromptSubmit", "SubagentStart"]);

export const DEFAULT_ADAPTERS = Object.freeze(["claude", "opencode"]);
const supportedAdapters = new Set([...DEFAULT_ADAPTERS, "codex"]);
const zshenvBlockPattern = /^# BEGIN agent-harness\n[\s\S]*?^# END agent-harness\n?/gm;

export function validateAdapters(adapters) {
  if (!Array.isArray(adapters) || adapters.length === 0 ||
      new Set(adapters).size !== adapters.length || adapters.some((value) => !supportedAdapters.has(value))) {
    throw new Error("adapters must be a nonempty list of distinct claude, opencode, or codex entries");
  }
  return [...adapters];
}

export function assertAbsolutePath(path) {
  if (typeof path !== "string" || !isAbsolute(path) || path.length > 4096 || /[\x00-\x1f\x7f]/.test(path)) {
    throw new Error("installer paths must be absolute and contain no control characters");
  }
}

export function resolveTargets({ home, repoRoot, runtimeDir = join(home, ".local/share/agent-harness-runtime"), stateDir = join(home, ".local/state/agent-harness"), codexHome = join(home, ".codex") }) {
  for (const path of [home, repoRoot, runtimeDir, stateDir, codexHome]) assertAbsolutePath(path);
  return {
    runtimeNodeBin: join(runtimeDir, "node_modules/node/bin/node"),
    stateDir,
    keyFile: join(stateDir, "auth.key"),
    socket: join(stateDir, "supervisor.sock"),
    ledger: join(stateDir, "events.sqlite"),
    coalescingConfig: join(stateDir, "coalescing.json"),
    groundingConfig: join(stateDir, "grounding.json"),
    installationManifest: join(stateDir, "installation.json"),
    localBin: join(home, ".local/bin"),
    wrapperPath: join(home, ".local/bin/agent-harness-supervisor"),
    plistPath: join(home, "Library/LaunchAgents/local.agent-harness.plist"),
    outLog: join(stateDir, "supervisor.out.log"),
    errLog: join(stateDir, "supervisor.err.log"),
    claudeSettings: join(home, ".claude/settings.json"),
    opencodeConfig: join(home, ".config/opencode/opencode.jsonc"),
    codexHooks: join(codexHome, "hooks.json"),
    zshenv: join(home, ".zshenv"),
    cliEntry: join(repoRoot, "src/cli.mjs"),
    claudeHook: join(repoRoot, "adapters/claude/hook.mjs"),
    codexHook: join(repoRoot, "adapters/codex/hook.mjs"),
    groundingHook: join(repoRoot, "src/grounding-hook.mjs"),
    opencodePlugin: join(repoRoot, "adapters/opencode/server.js"),
  };
}

export function generateKey() {
  return randomBytes(32);
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function xmlText(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

export function renderSupervisorWrapper(targets) {
  return `#!/bin/sh\nexec ${[targets.runtimeNodeBin, targets.cliEntry, "serve", "--socket", targets.socket, "--key-file", targets.keyFile, "--ledger", targets.ledger].map(shellQuote).join(" ")}\n`;
}

export function renderLaunchdPlist(targets) {
  const home = dirname(targets.zshenv);
  const path = `${dirname(targets.runtimeNodeBin)}:${join(home, ".local/bin")}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key>\n  <string>local.agent-harness</string>\n  <key>ProgramArguments</key>\n  <array>\n    <string>${xmlText(targets.wrapperPath)}</string>\n  </array>\n  <key>RunAtLoad</key>\n  <true/>\n  <key>KeepAlive</key>\n  <true/>\n  <key>EnvironmentVariables</key>\n  <dict>\n    <key>HOME</key>\n    <string>${xmlText(home)}</string>\n    <key>PATH</key>\n    <string>${xmlText(path)}</string>\n  </dict>\n  <key>StandardOutPath</key>\n  <string>${xmlText(targets.outLog)}</string>\n  <key>StandardErrorPath</key>\n  <string>${xmlText(targets.errLog)}</string>\n</dict>\n</plist>\n`;
}

export function renderCoalescingConfig() {
  return `${JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    windowMs: 600000,
    queueMax: 256,
    preserveLabels: ["lifecycle", "tool", "permission", "error"],
    dlpOverride: true,
  }, null, 2)}\n`;
}

export function renderGroundingConfig() {
  return `${JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    tokenBudget: 256,
    deadlineMs: 100,
    sources: ["project-notes", "repo-comments"],
  }, null, 2)}\n`;
}

export function claudeHookCommand(targets) {
  return hookCommand(targets, targets.claudeHook);
}

export function codexHookCommand(targets) {
  return hookCommand(targets, targets.codexHook);
}

export function claudeGroundingHookCommand(targets) {
  return groundingHookCommand(targets, "claude");
}

export function codexGroundingHookCommand(targets) {
  return groundingHookCommand(targets, "codex");
}

function groundingHookCommand(targets, platform) {
  return `AGENT_HARNESS_GROUNDING_CONFIG=${shellQuote(targets.groundingConfig)} AGENT_HARNESS_STATE_DIR=${shellQuote(targets.stateDir)} ${hookCommand(targets, targets.groundingHook)} --platform ${shellQuote(platform)}`;
}

function hookCommand(targets, hook) {
  return `AGENT_HARNESS_SOCKET=${shellQuote(targets.socket)} AGENT_HARNESS_KEY_FILE=${shellQuote(targets.keyFile)} ${shellQuote(targets.runtimeNodeBin)} ${shellQuote(hook)}`;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateHooks(settings, client) {
  if (!isRecord(settings)) throw new Error(`${client} settings must be an object`);
  if (!Object.hasOwn(settings, "hooks")) return;
  if (!isRecord(settings.hooks)) throw new Error(`${client} hooks must be an object`);
  for (const groups of Object.values(settings.hooks)) {
    if (!Array.isArray(groups)) throw new Error(`${client} hook events must contain arrays`);
    for (const group of groups) {
      if (!isRecord(group) || !Array.isArray(group.hooks) ||
          (Object.hasOwn(group, "matcher") && typeof group.matcher !== "string")) {
        throw new Error(`${client} hook groups must contain a hooks array and an optional string matcher`);
      }
      for (const hook of group.hooks) {
        if (!isRecord(hook) || typeof hook.type !== "string" ||
            (hook.type === "command" && (typeof hook.command !== "string" || hook.command.length === 0))) {
          throw new Error(`${client} hook handlers must have a type and command hooks require a command string`);
        }
      }
    }
  }
}

function mergeHooks(existingOrNull, events, command, client, background = false, handlerOptions = {}) {
  const settings = structuredClone(existingOrNull ?? {});
  validateHooks(settings, client);
  const hooks = settings.hooks ?? {};
  let changed = false;

  for (const event of events) {
    const groups = hooks[event] ?? [];
    // Keep an existing handler verbatim, including a user-disabled registration.
    if (groups.some((group) => group.hooks.some((hook) => hook.type === "command" && hook.command === command))) continue;
    const handler = { type: "command", command, timeout: 3, ...handlerOptions };
    if (background && event !== "SessionEnd") handler.async = true;
    hooks[event] = [...groups, { hooks: [handler] }];
    changed = true;
  }

  if (!changed) return { settings, changed: false };
  return { settings: { ...settings, hooks }, changed: true };
}

function removeHooks(existing, commands, client) {
  const settings = structuredClone(existing ?? {});
  validateHooks(settings, client);
  if (!settings.hooks) return { settings, changed: false };

  const hooks = settings.hooks;
  let changed = false;
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event].flatMap((group) => {
      const remainingHooks = group.hooks.filter((hook) => hook.type !== "command" || !commands.includes(hook.command));
      if (remainingHooks.length === group.hooks.length) return [group];
      changed = true;
      return remainingHooks.length === 0 ? [] : [{ ...group, hooks: remainingHooks }];
    });
    if (groups.length === 0) delete hooks[event];
    else hooks[event] = groups;
  }

  if (!changed) return { settings, changed: false };
  if (Object.keys(hooks).length === 0) {
    const { hooks: _hooks, ...withoutHooks } = settings;
    return { settings: withoutHooks, changed: true };
  }
  return { settings: { ...settings, hooks }, changed: true };
}

export function mergeClaudeSettings(existingOrNull, targets) {
  const telemetry = mergeHooks(existingOrNull, CLAUDE_HOOK_EVENTS, claudeHookCommand(targets), "Claude");
  const grounding = mergeHooks(telemetry.settings, GROUNDING_HOOK_EVENTS, claudeGroundingHookCommand(targets), "Claude");
  return { settings: grounding.settings, changed: telemetry.changed || grounding.changed };
}

export function removeClaudeSettings(existing, targets) {
  return removeHooks(existing, [claudeHookCommand(targets), claudeGroundingHookCommand(targets)], "Claude");
}

export function mergeCodexHooks(existingOrNull, targets) {
  const telemetry = mergeHooks(existingOrNull, CODEX_HOOK_EVENTS, codexHookCommand(targets), "Codex", true);
  // This synchronous producer caps its complete brief at 8,192 UTF-8 bytes.
  const grounding = mergeHooks(telemetry.settings, GROUNDING_HOOK_EVENTS, codexGroundingHookCommand(targets), "Codex", false, { additionalContextLimit: 0 });
  return { settings: grounding.settings, changed: telemetry.changed || grounding.changed };
}

export function removeCodexHooks(existing, targets, commands = [codexHookCommand(targets), codexGroundingHookCommand(targets)]) {
  return removeHooks(existing, commands, "Codex");
}

function parseJsonc(text) {
  let output = "";
  let quote = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];
    if (lineComment) {
      if (character === "\n") {
        lineComment = false;
        output += character;
      }
    } else if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
    } else if (quote) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quote = false;
    } else if (character === '"') {
      quote = true;
      output += character;
    } else if (character === "/" && next === "/") {
      lineComment = true;
      output += " ";
      index += 1;
    } else if (character === "/" && next === "*") {
      blockComment = true;
      output += " ";
      index += 1;
    } else if (character === "," && ["}", "]"].includes(text[skipTrivia(text, index + 1)])) {
      // JSONC trailing commas are allowed only outside string values.
    } else {
      output += character;
    }
  }
  if (blockComment || quote) throw new Error("unterminated OpenCode JSONC string or comment");
  const config = JSON.parse(output);
  if (!isRecord(config)) throw new Error("OpenCode settings must be an object");
  if (Object.hasOwn(config, "plugin") && !Array.isArray(config.plugin)) throw new Error("OpenCode plugin must be an array");
  return config;
}

function skipTrivia(text, index) {
  while (index < text.length) {
    if (/\s/.test(text[index])) {
      index += 1;
    } else if (text[index] === "/" && text[index + 1] === "/") {
      index = text.indexOf("\n", index + 2);
      if (index === -1) return text.length;
    } else if (text[index] === "/" && text[index + 1] === "*") {
      index = text.indexOf("*/", index + 2);
      if (index === -1) return text.length;
      index += 2;
    } else {
      break;
    }
  }
  return index;
}

function stringEnd(text, index) {
  for (let cursor = index + 1; cursor < text.length; cursor += 1) {
    if (text[cursor] === "\\") {
      cursor += 1;
    } else if (text[cursor] === '"') {
      return cursor + 1;
    }
  }
  throw new Error("unterminated JSON string");
}

function valueEnd(text, index) {
  const first = text[index];
  if (first === '"') return stringEnd(text, index);
  if (first !== "[" && first !== "{") {
    let cursor = index;
    while (cursor < text.length) {
      const character = text[cursor];
      if (",}]".includes(character) || /\s/.test(character)) break;
      if (character === "/" && (text[cursor + 1] === "/" || text[cursor + 1] === "*")) break;
      cursor += 1;
    }
    return cursor;
  }
  const closing = first === "[" ? "]" : "}";
  let depth = 0;
  for (let cursor = index; cursor < text.length; cursor += 1) {
    if (text[cursor] === '"') {
      cursor = stringEnd(text, cursor) - 1;
    } else if (text[cursor] === "/" && text[cursor + 1] === "/") {
      cursor = text.indexOf("\n", cursor + 2);
      if (cursor === -1) throw new Error("unterminated JSONC comment");
    } else if (text[cursor] === "/" && text[cursor + 1] === "*") {
      cursor = text.indexOf("*/", cursor + 2);
      if (cursor === -1) throw new Error("unterminated JSONC comment");
      cursor += 1;
    } else if (text[cursor] === first) {
      depth += 1;
    } else if (text[cursor] === closing && --depth === 0) {
      return cursor + 1;
    }
  }
  throw new Error("unterminated JSON value");
}

function topLevelProperty(text, name) {
  let cursor = skipTrivia(text, 0);
  if (text[cursor] !== "{") throw new Error("OpenCode config must be a JSONC object");
  const objectStart = cursor;
  cursor += 1;
  while (true) {
    cursor = skipTrivia(text, cursor);
    if (text[cursor] === "}") return { objectStart, objectEnd: cursor };
    const propertyStart = cursor;
    if (text[cursor] !== '"') throw new Error("OpenCode config must use quoted keys");
    const keyEnd = stringEnd(text, cursor);
    const key = JSON.parse(text.slice(cursor, keyEnd));
    cursor = skipTrivia(text, keyEnd);
    if (text[cursor] !== ":") throw new Error("invalid OpenCode config");
    const valueStart = skipTrivia(text, cursor + 1);
    const valueEndIndex = valueEnd(text, valueStart);
    if (key === name) return { objectStart, propertyStart, valueStart, valueEnd: valueEndIndex };
    cursor = skipTrivia(text, valueEndIndex);
    if (text[cursor] === ",") cursor += 1;
  }
}

function arrayElements(text, arrayStart, arrayEnd) {
  const elements = [];
  let cursor = skipTrivia(text, arrayStart + 1);
  while (cursor < arrayEnd - 1) {
    const start = cursor;
    const end = valueEnd(text, start);
    const next = skipTrivia(text, end);
    elements.push({ start, end, comma: text[next] === "," ? next : null });
    cursor = skipTrivia(text, text[next] === "," ? next + 1 : next);
  }
  return elements;
}

function lastSignificant(text, start, end) {
  let cursor = start;
  let last = "";
  while (cursor < end) {
    cursor = skipTrivia(text, cursor);
    if (cursor >= end) break;
    last = text[cursor];
    cursor = text[cursor] === '"' ? stringEnd(text, cursor) : cursor + 1;
  }
  return last;
}

function propertyIndent(text, propertyStart) {
  const lineStart = text.lastIndexOf("\n", propertyStart - 1) + 1;
  const indent = text.slice(lineStart, propertyStart).match(/^\s*/)?.[0];
  return indent || "  ";
}

function removeProperty(text, property) {
  const after = skipTrivia(text, property.valueEnd);
  if (text[after] === ",") return `${text.slice(0, property.propertyStart)}${text.slice(after + 1)}`;
  let before = property.propertyStart - 1;
  while (before >= 0 && /\s/.test(text[before])) before -= 1;
  if (text[before] === ",") return `${text.slice(0, before)}${text.slice(property.valueEnd)}`;
  return `${text.slice(0, property.propertyStart)}${text.slice(property.valueEnd)}`;
}

export function insertOpenCodePlugin(jsoncTextOrNull, targets) {
  const plugin = pathToFileURL(targets.opencodePlugin).href;
  if (jsoncTextOrNull === null) {
    return { text: `${JSON.stringify({ plugin: [plugin] }, null, 2)}\n`, changed: true };
  }
  const text = jsoncTextOrNull;
  const config = parseJsonc(text);
  if (Array.isArray(config.plugin) && config.plugin.includes(plugin)) return { text, changed: false };
  const property = topLevelProperty(text, "plugin");
  if (!property.valueStart) {
    const root = topLevelProperty(text, "__agent_harness_missing_property__");
    const body = text.slice(root.objectStart + 1, root.objectEnd);
    const needsComma = Object.keys(config).length > 0 && lastSignificant(text, root.objectStart + 1, root.objectEnd) !== ",";
    const indent = propertyIndent(text, body.search(/\S/) === -1 ? root.objectStart + 1 : root.objectStart + 1 + body.search(/\S/));
    const prefix = body.trim() ? (needsComma ? ",\n" : "\n") : "\n";
    return {
      text: `${text.slice(0, root.objectEnd)}${prefix}${indent}"plugin": [${JSON.stringify(plugin)}]\n${text.slice(root.objectEnd)}`,
      changed: true,
    };
  }
  if (text[property.valueStart] !== "[") throw new Error("OpenCode plugin must be an array");
  const elements = arrayElements(text, property.valueStart, property.valueEnd);
  const indent = propertyIndent(text, property.propertyStart);
  const insertion = elements.length === 0
    ? `\n${indent}  ${JSON.stringify(plugin)}\n`
    : `${lastSignificant(text, property.valueStart + 1, property.valueEnd - 1) === "," ? "" : ","}\n${indent}  ${JSON.stringify(plugin)}\n`;
  return {
    text: `${text.slice(0, property.valueEnd - 1)}${insertion}${text.slice(property.valueEnd - 1)}`,
    changed: true,
  };
}

export function removeOpenCodePlugin(text, targets) {
  if (text === null || text === undefined) return { text, changed: false };
  const plugin = pathToFileURL(targets.opencodePlugin).href;
  const config = parseJsonc(text);
  if (!Array.isArray(config.plugin) || !config.plugin.includes(plugin)) return { text, changed: false };
  const property = topLevelProperty(text, "plugin");
  if (text[property.valueStart] !== "[") return { text, changed: false };
  const elements = arrayElements(text, property.valueStart, property.valueEnd);
  const element = elements.find(({ start, end }) => text[start] === '"' && JSON.parse(text.slice(start, end)) === plugin);
  if (!element) return { text, changed: false };
  if (elements.length === 1) return { text: removeProperty(text, property), changed: true };
  if (element.comma !== null) return { text: `${text.slice(0, element.start)}${text.slice(element.comma + 1)}`, changed: true };
  const previous = elements[elements.indexOf(element) - 1];
  return { text: `${text.slice(0, previous.comma)}${text.slice(element.end)}`, changed: true };
}

export function zshenvBlock(targets) {
  return `# BEGIN agent-harness\nexport AGENT_HARNESS_SOCKET=${shellQuote(targets.socket)}\nexport AGENT_HARNESS_KEY_FILE=${shellQuote(targets.keyFile)}\nexport AGENT_HARNESS_COALESCING_CONFIG=${shellQuote(targets.coalescingConfig)}\nexport AGENT_HARNESS_GROUNDING_CONFIG=${shellQuote(targets.groundingConfig)}\n# END agent-harness\n`;
}

export function applyZshenv(textOrNull, targets) {
  const existing = textOrNull ?? "";
  const block = zshenvBlock(targets);
  const blocks = [...existing.matchAll(zshenvBlockPattern)];
  if (blocks.length > 0) {
    let replaced = false;
    const text = existing.replace(zshenvBlockPattern, () => {
      if (replaced) return "";
      replaced = true;
      return block;
    });
    return { text, changed: text !== existing };
  }
  const withoutBlocks = existing;
  const separator = withoutBlocks.length > 0 && !withoutBlocks.endsWith("\n") ? "\n" : "";
  const text = `${withoutBlocks}${separator}${block}`;
  return { text, changed: text !== existing };
}

export function removeZshenv(text) {
  const existing = text ?? "";
  const result = existing.replace(zshenvBlockPattern, "");
  return { text: result, changed: result !== existing };
}
