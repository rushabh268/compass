import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import {
  CLAUDE_HOOK_EVENTS,
  applyZshenv,
  claudeHookCommand,
  insertOpenCodePlugin,
  mergeClaudeSettings,
  removeClaudeSettings,
  removeOpenCodePlugin,
  removeZshenv,
  renderCoalescingConfig,
  renderLaunchdPlist,
  renderSupervisorWrapper,
  resolveTargets,
  zshenvBlock,
} from "../../install/plan.mjs";

const FOREIGN_USER = "/Users/example";
const events = [
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

function fixtureTargets() {
  return resolveTargets({
    home: "/private/tmp/agent-harness-home",
    repoRoot: "/private/tmp/agent-harness-repo",
  });
}

function assertPathIsPortable(path, home, repoRoot) {
  assert.equal(isAbsolute(path), true, `${path} must be absolute`);
  assert.ok(
    [home, repoRoot].some((root) => path === root || relative(root, path) && !relative(root, path).startsWith("..")),
    `${path} must be under ${home} or ${repoRoot}`,
  );
  assert.equal(path.includes(FOREIGN_USER), false, `${path} contains a foreign user's home`);
}

function assertNoForeignUser(value) {
  assert.equal(String(value).includes(FOREIGN_USER), false, "generated output contains a foreign user's home");
}

function stripJsonc(input) {
  let output = "";
  let quote = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    const next = input[index + 1];

    if (lineComment) {
      if (character === "\n") {
        lineComment = false;
        output += character;
      }
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quote = false;
      continue;
    }
    if (character === '"') {
      quote = true;
      output += character;
    } else if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
    } else if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
    } else {
      output += character;
    }
  }

  return output.replace(/,\s*([}\]])/g, "$1");
}

function parseJsonc(input) {
  return JSON.parse(stripJsonc(input));
}

function assertScalarCommentPluginRoundTrip(text, targets, comment, scalarKey, scalarValue) {
  const plugin = `file://${targets.opencodePlugin}`;
  const inserted = insertOpenCodePlugin(text, targets);
  const parsed = parseJsonc(inserted.text);

  assert.equal(inserted.changed, true);
  assert.equal(inserted.text.includes(comment), true);
  assert.equal(inserted.text.split(plugin).length - 1, 1);
  assert.equal(parsed[scalarKey], scalarValue);
  assert.deepEqual(parsed.mcp, { x: {} });
  assert.equal(parsed.plugin.includes(plugin), true);

  const second = insertOpenCodePlugin(inserted.text, targets);
  assert.equal(second.changed, false);
  assert.equal(second.text, inserted.text);
  assert.equal(second.text.includes(comment), true);

  const removed = removeOpenCodePlugin(inserted.text, targets);
  assert.equal(removed.changed, true);
  assert.equal(removed.text.includes(comment), true);
  const removedParsed = parseJsonc(removed.text);
  assert.equal(removedParsed.plugin?.includes(plugin) ?? false, false);
  assert.deepEqual(removedParsed.mcp, { x: {} });
}

function hookGroups(settings, event) {
  return settings.hooks?.[event] ?? [];
}

function findCommandGroups(settings, event, command) {
  return hookGroups(settings, event).filter((group) =>
    group.hooks?.some((hook) => hook.command === command),
  );
}

test("resolveTargets derives portable absolute paths from home and repoRoot", () => {
  const home = "/private/tmp/agent-harness-home";
  const repoRoot = "/private/tmp/agent-harness-repo";
  const targets = resolveTargets({ home, repoRoot });

  assert.deepEqual(targets, {
    runtimeNodeBin: join(home, ".local/share/agent-harness-runtime/node_modules/node/bin/node"),
    stateDir: join(home, ".local/state/agent-harness"),
    keyFile: join(home, ".local/state/agent-harness/auth.key"),
    socket: join(home, ".local/state/agent-harness/supervisor.sock"),
    ledger: join(home, ".local/state/agent-harness/events.sqlite"),
    coalescingConfig: join(home, ".local/state/agent-harness/coalescing.json"),
    groundingConfig: join(home, ".local/state/agent-harness/grounding.json"),
    installationManifest: join(home, ".local/state/agent-harness/installation.json"),
    localBin: join(home, ".local/bin"),
    wrapperPath: join(home, ".local/bin/agent-harness-supervisor"),
    plistPath: join(home, "Library/LaunchAgents/local.agent-harness.plist"),
    outLog: join(home, ".local/state/agent-harness/supervisor.out.log"),
    errLog: join(home, ".local/state/agent-harness/supervisor.err.log"),
    claudeSettings: join(home, ".claude/settings.json"),
    opencodeConfig: join(home, ".config/opencode/opencode.jsonc"),
    codexHooks: join(home, ".codex/hooks.json"),
    zshenv: join(home, ".zshenv"),
    cliEntry: join(repoRoot, "src/cli.mjs"),
    claudeHook: join(repoRoot, "adapters/claude/hook.mjs"),
    codexHook: join(repoRoot, "adapters/codex/hook.mjs"),
    groundingHook: join(repoRoot, "src/grounding-hook.mjs"),
    opencodePlugin: join(repoRoot, "adapters/opencode/server.js"),
  });

  for (const value of Object.values(targets)) assertPathIsPortable(value, home, repoRoot);
});

test("resolveTargets honors runtimeDir and stateDir while remaining deterministic and pure", () => {
  const home = "/private/tmp/agent-harness-home";
  const repoRoot = "/private/tmp/agent-harness-repo";
  const runtimeDir = join(home, "custom/runtime");
  const stateDir = join(home, "custom/state");
  const first = resolveTargets({ home, repoRoot, runtimeDir, stateDir });
  const second = resolveTargets({ home, repoRoot, runtimeDir, stateDir });

  assert.deepEqual(first, second);
  assert.equal(first.runtimeNodeBin, join(runtimeDir, "node_modules/node/bin/node"));
  assert.equal(first.stateDir, stateDir);
  assert.equal(first.keyFile, join(stateDir, "auth.key"));
  assert.equal(first.socket, join(stateDir, "supervisor.sock"));
  assert.equal(first.ledger, join(stateDir, "events.sqlite"));
  assert.equal(first.coalescingConfig, join(stateDir, "coalescing.json"));
  for (const value of Object.values(first)) assertPathIsPortable(value, home, repoRoot);
});

test("renderSupervisorWrapper emits one shell exec for the planned runtime and CLI", () => {
  const targets = fixtureTargets();
  const wrapper = renderSupervisorWrapper(targets);
  const lines = wrapper.trimEnd().split("\n");

  assert.equal(lines[0], "#!/bin/sh");
  assert.equal(lines.length, 2);
  assert.equal(
    lines[1],
    `exec '${targets.runtimeNodeBin}' '${targets.cliEntry}' 'serve' '--socket' '${targets.socket}' '--key-file' '${targets.keyFile}' '--ledger' '${targets.ledger}'`,
  );
  for (const path of [targets.runtimeNodeBin, targets.cliEntry, targets.socket, targets.keyFile, targets.ledger]) {
    assert.equal(wrapper.includes(path), true);
  }
  assertNoForeignUser(wrapper);
});

test("renderLaunchdPlist contains the portable launchd contract", () => {
  const targets = fixtureTargets();
  const plist = renderLaunchdPlist(targets);

  assert.match(plist, /<key>Label<\/key>\s*<string>local\.agent-harness<\/string>/);
  assert.match(plist, new RegExp(`<key>ProgramArguments<\\/key>\\s*<array>\\s*<string>${targets.wrapperPath}<\\/string>\\s*<\\/array>`));
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\s*\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\s*\/>/);
  assert.match(plist, new RegExp(`<key>HOME<\\/key>\\s*<string>${targets.home ?? dirname(targets.zshenv)}<\\/string>`));
  assert.match(plist, new RegExp(`<key>PATH<\\/key>\\s*<string>${dirname(targets.runtimeNodeBin)}:`));
  assert.match(plist, new RegExp(`<key>StandardOutPath<\\/key>\\s*<string>${targets.outLog}<\\/string>`));
  assert.match(plist, new RegExp(`<key>StandardErrorPath<\\/key>\\s*<string>${targets.errLog}<\\/string>`));
  assertNoForeignUser(plist);
});

test("renderCoalescingConfig returns the enabled policy and conforms to its schema", async () => {
  const rendered = renderCoalescingConfig();
  assert.equal(typeof rendered, "string");
  const config = JSON.parse(rendered);
  assert.deepEqual(config, {
    schemaVersion: 1,
    enabled: true,
    windowMs: 600000,
    queueMax: 256,
    preserveLabels: ["lifecycle", "tool", "permission", "error"],
    dlpOverride: true,
  });

  const schema = JSON.parse(await readFile(new URL("../../config/coalescing.schema.json", import.meta.url), "utf8"));
  const ajv = new Ajv2020({ allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  assert.equal(validate(config), true, JSON.stringify(validate.errors));
  assert.deepEqual(JSON.parse(JSON.stringify(config)), JSON.parse(rendered));
});

test("CLAUDE_HOOK_EVENTS is exactly the portable 17-event contract", () => {
  assert.equal(Array.isArray(CLAUDE_HOOK_EVENTS), true);
  assert.equal(CLAUDE_HOOK_EVENTS.length, 17);
  assert.deepEqual(new Set(CLAUDE_HOOK_EVENTS), new Set(events));
});

test("claudeHookCommand composes only the planned environment and hook paths", () => {
  const targets = fixtureTargets();
  assert.equal(
    claudeHookCommand(targets),
    `AGENT_HARNESS_SOCKET='${targets.socket}' AGENT_HARNESS_KEY_FILE='${targets.keyFile}' '${targets.runtimeNodeBin}' '${targets.claudeHook}'`,
  );
  assertNoForeignUser(claudeHookCommand(targets));
});

test("mergeClaudeSettings preserves unrelated hooks, appends one group, and is idempotent", () => {
  const targets = fixtureTargets();
  const unrelatedCommand = "echo keep-stop";
  const original = {
    permissions: { allow: ["Bash(git status)"] },
    hooks: {
      Stop: [{ matcher: "", hooks: [{ type: "command", command: unrelatedCommand }] }],
      UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo unrelated-event" }] }],
    },
  };
  const before = structuredClone(original);
  const first = mergeClaudeSettings(original, targets);

  assert.notEqual(first.settings, original);
  assert.deepEqual(original, before);
  assert.equal(first.changed, true);
  assert.equal(first.settings.permissions.allow[0], "Bash(git status)");
  assert.equal(hookGroups(first.settings, "Stop").length, 2);
  assert.deepEqual(hookGroups(first.settings, "Stop")[0], original.hooks.Stop[0]);
  assert.equal(findCommandGroups(first.settings, "Stop", unrelatedCommand).length, 1);
  for (const event of CLAUDE_HOOK_EVENTS) {
    const groups = findCommandGroups(first.settings, event, claudeHookCommand(targets));
    assert.equal(groups.length, 1, `${event} should contain our hook exactly once`);
    assert.deepEqual(groups[0].hooks.find((hook) => hook.command === claudeHookCommand(targets)), {
      type: "command",
      command: claudeHookCommand(targets),
      timeout: 3,
    });
  }

  const second = mergeClaudeSettings(first.settings, targets);
  assert.equal(second.changed, false);
  assert.deepEqual(second.settings, first.settings);
  for (const event of CLAUDE_HOOK_EVENTS) assert.equal(findCommandGroups(second.settings, event, claudeHookCommand(targets)).length, 1);
});

test("mergeClaudeSettings accepts null and still installs every event without mutating a caller", () => {
  const targets = fixtureTargets();
  const merged = mergeClaudeSettings(null, targets);

  assert.equal(merged.changed, true);
  assert.deepEqual(Object.keys(merged.settings), ["hooks"]);
  for (const event of CLAUDE_HOOK_EVENTS) assert.equal(findCommandGroups(merged.settings, event, claudeHookCommand(targets)).length, 1);
});

test("removeClaudeSettings removes only our command and round-trips the representative fixture", () => {
  const targets = fixtureTargets();
  const original = {
    hooks: {
      Stop: [{ matcher: "", hooks: [{ type: "command", command: "echo keep-stop" }] }],
      UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo keep-event" }] }],
    },
    model: "sonnet",
  };
  const merged = mergeClaudeSettings(original, targets);
  const removed = removeClaudeSettings(merged.settings, targets);

  assert.equal(removed.changed, true);
  assert.deepEqual(removed.settings, original);
  const unchanged = removeClaudeSettings(original, targets);
  assert.equal(unchanged.changed, false);
  assert.deepEqual(unchanged.settings, original);
});

test("insertOpenCodePlugin preserves JSONC comments and unrelated top-level keys", () => {
  const targets = fixtureTargets();
  const original = `{
  // Keep this provider configuration.
  "mcp": {
    "local": { "type": "local", },
  },
  "plugin": [
    // Keep the existing plugin.
    "file://existing-plugin",
  ],
}`;
  const inserted = insertOpenCodePlugin(original, targets);
  const parsed = parseJsonc(inserted.text);

  assert.equal(inserted.changed, true);
  assert.equal(inserted.text.includes("// Keep this provider configuration."), true);
  assert.equal(inserted.text.includes("// Keep the existing plugin."), true);
  assert.deepEqual(parsed.mcp, { local: { type: "local" } });
  assert.deepEqual(parsed.plugin, ["file://existing-plugin", `file://${targets.opencodePlugin}`]);

  const second = insertOpenCodePlugin(inserted.text, targets);
  assert.equal(second.changed, false);
  assert.equal(second.text, inserted.text);
  assert.deepEqual(parseJsonc(second.text), parsed);
  assertNoForeignUser(second.text);
});

test("insertOpenCodePlugin round-trips a scalar before a brace-and-comma line comment", () => {
  const targets = fixtureTargets();
  assertScalarCommentPluginRoundTrip(
    `{
  "autoupdate": false, // note, with {braces} and , commas ]
  "mcp": { "x": {} }
}`,
    targets,
    "// note, with {braces} and , commas ]",
    "autoupdate",
    false,
  );
});

test("insertOpenCodePlugin round-trips a scalar before a punctuation-heavy block comment", () => {
  const targets = fixtureTargets();
  assertScalarCommentPluginRoundTrip(
    `{
  "port": 5 /* has , and ] */,
  "mcp": { "x": {} }
}`,
    targets,
    "/* has , and ] */",
    "port",
    5,
  );
});

test("insertOpenCodePlugin round-trips a boolean followed directly by a comma line comment", () => {
  const targets = fixtureTargets();
  assertScalarCommentPluginRoundTrip(
    `{
  "autoshare": true // share, but careful
  ,
  "mcp": { "x": {} }
}`,
    targets,
    "// share, but careful",
    "autoshare",
    true,
  );
});

test("insertOpenCodePlugin adds a plugin array when the top-level key is absent", () => {
  const targets = fixtureTargets();
  const inserted = insertOpenCodePlugin('{\n  "mcp": {},\n}', targets);
  assert.equal(inserted.changed, true);
  assert.deepEqual(parseJsonc(inserted.text), {
    mcp: {},
    plugin: [`file://${targets.opencodePlugin}`],
  });
});

test("removeOpenCodePlugin removes only our entry and preserves JSONC text", () => {
  const targets = fixtureTargets();
  const original = `{
  // Keep this comment.
  "plugin": ["file://other", "file://${targets.opencodePlugin}"],
  "mcp": { "keep": true },
}`;
  const removed = removeOpenCodePlugin(original, targets);

  assert.equal(removed.changed, true);
  assert.equal(removed.text.includes("// Keep this comment."), true);
  assert.deepEqual(parseJsonc(removed.text), { plugin: ["file://other"], mcp: { keep: true } });
  const unchanged = removeOpenCodePlugin(removed.text, targets);
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.text, removed.text);
});

test("zshenv block exports all planned environment paths and has agent-harness markers", () => {
  const targets = fixtureTargets();
  const block = zshenvBlock(targets);

  assert.match(block, /BEGIN agent-harness/);
  assert.match(block, /END agent-harness/);
  assert.match(block, new RegExp(`AGENT_HARNESS_SOCKET='${targets.socket}'`));
  assert.match(block, new RegExp(`AGENT_HARNESS_KEY_FILE='${targets.keyFile}'`));
  assert.match(block, new RegExp(`AGENT_HARNESS_COALESCING_CONFIG='${targets.coalescingConfig}'`));
  assertNoForeignUser(block);
});

test("applyZshenv appends, updates, and idempotently replaces only its block", () => {
  const oldTargets = resolveTargets({ home: "/private/tmp/old-home", repoRoot: "/private/tmp/repo" });
  const targets = fixtureTargets();
  const original = "export OPENCODE_SERVER_PASSWORD=guard\n# keep this line\n";
  const first = applyZshenv(original, oldTargets);
  assert.equal(first.changed, true);
  assert.equal(first.text.startsWith(original), true);
  assert.equal(first.text.split("BEGIN agent-harness").length - 1, 1);

  const updated = applyZshenv(first.text, targets);
  assert.equal(updated.changed, true);
  assert.equal(updated.text.includes(oldTargets.socket), false);
  assert.equal(updated.text.includes(targets.socket), true);
  assert.equal(updated.text.split("BEGIN agent-harness").length - 1, 1);

  const second = applyZshenv(updated.text, targets);
  assert.equal(second.changed, false);
  assert.equal(second.text, updated.text);
  const removed = removeZshenv(updated.text);
  assert.equal(removed.changed, true);
  assert.equal(removed.text, original);
  const unchanged = removeZshenv(original);
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.text, original);
});

test("applyZshenv accepts null and removeZshenv restores an empty file", () => {
  const targets = fixtureTargets();
  const applied = applyZshenv(null, targets);
  assert.equal(applied.changed, true);
  assert.equal(applied.text, zshenvBlock(targets));
  assert.deepEqual(removeZshenv(applied.text), { text: "", changed: true });
});

test("resolveTargets includes groundingConfig path under stateDir", () => {
  const home = "/private/tmp/agent-harness-home";
  const repoRoot = "/private/tmp/agent-harness-repo";
  const targets = resolveTargets({ home, repoRoot });

  assert.equal(Object.hasOwn(targets, "groundingConfig"), true, "targets must have groundingConfig");
  assert.equal(targets.groundingConfig, join(targets.stateDir, "grounding.json"));
  assertPathIsPortable(targets.groundingConfig, home, repoRoot);
  assert.equal(targets.groundingConfig.includes(FOREIGN_USER), false);
});

test("zshenvBlock exports AGENT_HARNESS_GROUNDING_CONFIG pointing to groundingConfig path", () => {
  const targets = fixtureTargets();
  const block = zshenvBlock(targets);

  assert.equal(block.includes("AGENT_HARNESS_GROUNDING_CONFIG"), true);
  assert.equal(block.includes(targets.groundingConfig), true);
  assertNoForeignUser(block);
});

test("renderCoalescingConfig conforms to schema", async () => {
  const rendered = renderCoalescingConfig();
  assert.equal(typeof rendered, "string");
  const config = JSON.parse(rendered);

  const schema = JSON.parse(await readFile(new URL("../../config/coalescing.schema.json", import.meta.url), "utf8"));
  const ajv = new Ajv2020({ allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  assert.equal(validate(config), true, JSON.stringify(validate.errors));
});
