import { hookSubject, identityHMAC as hmac } from '../../src/identity.mjs';
import { randomUUID } from "node:crypto";
import { types } from "node:util";

import { scanText } from "../../src/dlp/classify.mjs";
import { createDecision } from "../../src/protocol/decision.mjs";
import { createEvent } from "../../src/protocol/event.mjs";

export const MAX_CODEX_PAYLOAD_BYTES = 1024 * 1024;
const MAX_PAYLOAD_DEPTH = 64;
const MAX_PAYLOAD_VALUES = 65_536;
const SUPPORTED_HOOK_EVENTS = new Set([
  "SessionStart", "SessionEnd", "SubagentStart", "SubagentStop", "PreToolUse",
  "PermissionRequest", "PostToolUse", "PreCompact", "PostCompact", "UserPromptSubmit",
  "Stop", "Interrupt",
]);
// These are payload names, not matcher aliases. Unknown extension/MCP names
// remain opaque even when they resemble a familiar tool.
const TOOL_NAMES = new Map([["Bash", "Bash"], ["apply_patch", "ApplyPatch"], ["spawn_agent", "Task"]]);
const SUBAGENT_EVENTS = new Set(["SubagentStart", "SubagentStop"]);

function clonePayload(payload) {
  let bytes = 0;
  let values = 0;
  const ancestors = new Set();
  const consume = (amount) => {
    bytes += amount;
    if (bytes > MAX_CODEX_PAYLOAD_BYTES) throw new RangeError("payload exceeds size limit");
  };
  const encodedSize = (value) => {
    if (typeof value === "string" && value.length > MAX_CODEX_PAYLOAD_BYTES) {
      throw new RangeError("payload exceeds size limit");
    }
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  };
  const visit = (value, depth) => {
    if (depth > MAX_PAYLOAD_DEPTH) throw new RangeError("payload exceeds nesting limit");
    if (++values > MAX_PAYLOAD_VALUES) throw new RangeError("payload exceeds values limit");
    if (value === null || typeof value === "string" || typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value))) {
      consume(encodedSize(value));
      return value;
    }
    if (typeof value !== "object" || types.isProxy(value) || ancestors.has(value)) {
      throw new TypeError("payload must contain only plain JSON values");
    }
    const array = Array.isArray(value);
    if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)) {
      throw new TypeError("payload must contain only plain JSON values");
    }
    const fields = Reflect.ownKeys(value);
    if (array && fields.length !== value.length + 1) throw new TypeError("payload arrays must be dense JSON arrays");
    if ((array ? value.length : fields.length) > MAX_PAYLOAD_VALUES - values) {
      throw new RangeError("payload exceeds values limit");
    }
    ancestors.add(value);
    const copy = array ? [] : {};
    const keys = array ? Array.from({ length: value.length }, (_, index) => String(index)) : fields;
    if (keys.some((field) => typeof field !== "string")) throw new TypeError("payload must contain only JSON keys");
    consume(2 + Math.max(0, keys.length - 1));
    for (const field of array ? keys : keys.sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
        throw new TypeError("payload must contain only JSON values and no accessors");
      }
      if (!array) consume(encodedSize(field) + 1);
      Object.defineProperty(copy, field, {
        value: visit(descriptor.value, depth + 1),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    ancestors.delete(value);
    return copy;
  };
  const copy = visit(payload, 0);
  if (copy === null || typeof copy !== "object" || Array.isArray(copy)) {
    throw new TypeError("payload must be a plain JSON object");
  }
  return copy;
}


function string(value, field) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(field + " must be a nonempty string");
  }
  return value;
}

function optionalString(payload, field) {
  return Object.hasOwn(payload, field) ? string(payload[field], field) : undefined;
}

// One occurrence identifies one host callback. A caller retrying delivery must
// reuse the resulting immutable event, including its timestamp.
export function translateCodexHook(payload, { authKey, now = new Date(), occurrenceID = randomUUID() } = {}) {
  if (!Buffer.isBuffer(authKey) || authKey.byteLength < 32) throw new TypeError("authKey must be a Buffer of at least 32 bytes");
  const copy = clonePayload(payload);
  const sessionID = string(copy.session_id, "session_id");
  const eventType = string(copy.hook_event_name, "hook_event_name");
  if (!SUPPORTED_HOOK_EVENTS.has(eventType)) throw new TypeError("unsupported hook_event_name");
  const occurrence = string(occurrenceID, "occurrenceID");
  const subagent = SUBAGENT_EVENTS.has(eventType);
  // Codex SubagentStart/Stop use the parent's session_id and a separate agent_id.
  const subjectID = subagent ? string(copy.agent_id, "agent_id") : sessionID;
  if (hookSubject("codex", copy)?.nativeID !== subjectID) throw new TypeError("invalid subject");
  const turnID = optionalString(copy, "turn_id");
  const cwd = optionalString(copy, "cwd");
  const toolName = optionalString(copy, "tool_name");
  const toolUseID = optionalString(copy, "tool_use_id");
  const identity = JSON.stringify([sessionID, subjectID, turnID ?? null, eventType, occurrence]);
  const ruleIDs = [...new Set(scanText(JSON.stringify(copy)).map(({ ruleID }) => "dlp." + ruleID))].sort();
  return createEvent({
    schemaVersion: 1,
    platform: "codex",
    adapterVersion: "1",
    runID: hmac(authKey, "codex.run", sessionID),
    sessionHMAC: hmac(authKey, "codex.session", subjectID),
    eventID: hmac(authKey, "codex.event", identity),
    dedupeKey: hmac(authKey, "codex.dedupe", identity),
    eventType,
    timestamp: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
    ...(subagent ? { parentSessionHMAC: hmac(authKey, "codex.session", sessionID) } : {}),
    ...(toolUseID ? { callID: hmac(authKey, "codex.call", JSON.stringify([sessionID, subjectID, turnID ?? null, toolUseID])) } : {}),
    ...(toolName ? { toolName: TOOL_NAMES.get(toolName) ?? hmac(authKey, "codex.tool", toolName) } : {}),
    ...(cwd ? { worktreeID: hmac(authKey, "codex.cwd", cwd) } : {}),
    ...(ruleIDs.length > 0 ? { decision: createDecision({
      schemaVersion: 1,
      action: "observe",
      ruleIDs,
      reason: "Credential-shaped content was observed",
    }) } : {}),
  });
}
