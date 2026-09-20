import { types } from "node:util";

import { createDecision } from "./decision.mjs";

const requiredFields = [
  "schemaVersion",
  "eventID",
  "runID",
  "platform",
  "sessionHMAC",
  "eventType",
  "timestamp",
  "dedupeKey",
];

const optionalStringFields = [
  "adapterVersion",
  "previousEventHMAC",
  "parentSessionHMAC",
  "attemptID",
  "callID",
  "repoID",
  "worktreeID",
  "toolName",
  "subjectID",
];

const allowedFields = new Set([
  ...requiredFields, "sequence", ...optionalStringFields, "decision", "summary", "metadata",
]);
const platforms = new Set(["claude", "opencode", "codex"]);
const digestFields = new Set([
  "sessionHMAC", "previousEventHMAC", "parentSessionHMAC", "callID", "repoID", "worktreeID",
]);
const labelFields = new Set(["eventType", "toolName"]);
export const canonicalLabels = new Set([
  "ApplyPatch", "Bash", "CommandExecute", "ConfigChange", "Edit", "FileEdit", "Glob", "Grep",
  "FileWatcher", "GroundingInjection", "HarnessMetrics", "InstallationUpdate", "Interrupt", "LspDiagnostics", "LspUpdate", "MessagePartDelta", "MessagePartRemove",
  "MessagePartUpdate", "MessageRemove", "MessageUpdate", "Notification", "PermissionRequest",
  "PermissionResponse", "PostCompact", "PostToolUse", "PostToolUseFailure", "PreCompact",
  "PreToolUse", "Pty", "QuestionRequest", "QuestionResponse", "Read", "ServerConnected", "SessionDiff", "SessionEnd", "SessionStart",
  "SessionStatus", "SessionUpdate",
  "Skill", "Stop", "StopFailure", "SubagentStart", "SubagentStop", "Task", "TaskCompleted",
  "TeammateIdle", "TodoRead", "TodoUpdate", "TodoWrite", "TuiCommandExecute", "TuiPromptAppend",
  "TuiToastShow", "UserPromptSubmit", "Vcs", "WebFetch", "WebSearch", "WorktreeCreate", "WorktreeRemove",
  "Write",
]);
const digestPattern = /^[0-9a-f]{64}$/;
const maxStringLength = 1024;
const summaryCounterFields = Object.freeze([
  "coalesced", "messagePartDelta", "messagePartUpdate", "messageUpdate",
  "sessionStatus", "sessionDiff", "todoUpdate", "noise", "queueFull",
]);
const summaryCounterFieldSet = new Set(summaryCounterFields);
// GroundingInjection may target sessionHMAC while retaining its monthly runID.
// Targetless historical events remain monthly/unassigned; no new event-v1 field.
// GroundingInjection metadata is a CLOSED, structured summary of what grounding
// content was injected into a chat turn. It never carries raw brief text,
// vault contents, comment bodies, cwd, or branch names -- only bounded
// counters, a match-reason enum, and path-only source references.
const groundingMetadataCounterFields = Object.freeze(["bytes", "approxTokens", "commentFiles", "latencyMs"]);
const groundingMetadataFields = Object.freeze(["sources", "matchReason", ...groundingMetadataCounterFields]);
const groundingMetadataFieldSet = new Set(groundingMetadataFields);
const groundingSourceKinds = new Set(["project-notes", "repo-comment"]);
const groundingMatchReasons = new Set(["ticket", "branch-folder-overlap", "none"]);

function assertPlainObject(value, kind = "event") {
  if (value === null || typeof value !== "object" || types.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${kind} must be a plain JSON object`);
  }
  for (const field of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (typeof field !== "string" || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${kind} must be a plain JSON object`);
    }
  }
}

function assertSummaryCounter(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`summary.${field} must be a nonnegative safe integer`);
  }
}

function assertSummary(value) {
  assertPlainObject(value, "summary");
  for (const field of Object.keys(value)) {
    if (!summaryCounterFieldSet.has(field)) {
      throw new TypeError(`unknown summary field: ${field}`);
    }
    assertSummaryCounter(value[field], field);
  }
  for (const field of summaryCounterFields) {
    if (!Object.hasOwn(value, field)) {
      throw new TypeError(`summary must include every counter field: ${summaryCounterFields.join(", ")}`);
    }
  }
}

function assertGroundingMetadataCounter(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`metadata.${field} must be a nonnegative safe integer`);
  }
}

function assertGroundingSource(source, index) {
  assertPlainObject(source, `metadata.sources[${index}]`);
  for (const field of Object.keys(source)) {
    if (field !== "kind" && field !== "ref") {
      throw new TypeError(`unknown metadata.sources[${index}] field: ${field}`);
    }
  }
  if (!groundingSourceKinds.has(source.kind)) {
    throw new TypeError(`metadata.sources[${index}].kind must be an enum value: project-notes, repo-comment`);
  }
  assertString(source.ref, `metadata.sources[${index}].ref`);
}

function assertGroundingMetadata(value) {
  assertPlainObject(value, "metadata");
  for (const field of Object.keys(value)) {
    if (!groundingMetadataFieldSet.has(field)) {
      throw new TypeError(`unknown metadata field: ${field}`);
    }
  }
  if (!Object.hasOwn(value, "sources")) throw new TypeError("metadata.sources is required");
  if (!Array.isArray(value.sources) || types.isProxy(value.sources)) {
    throw new TypeError("metadata.sources must be an array of {kind, ref}");
  }
  value.sources.forEach((source, index) => assertGroundingSource(source, index));
  if (!Object.hasOwn(value, "matchReason")) throw new TypeError("metadata.matchReason is required");
  if (!groundingMatchReasons.has(value.matchReason)) {
    throw new TypeError("metadata.matchReason must be an enum value: ticket, branch-folder-overlap, none");
  }
  for (const field of groundingMetadataCounterFields) {
    if (Object.hasOwn(value, field)) assertGroundingMetadataCounter(value[field], field);
  }
}

function freezeGroundingMetadata(value) {
  const metadata = {
    sources: Object.freeze(value.sources.map((source) => Object.freeze({ kind: source.kind, ref: source.ref }))),
    matchReason: value.matchReason,
  };
  for (const field of groundingMetadataCounterFields) {
    if (Object.hasOwn(value, field)) metadata[field] = value[field];
  }
  return Object.freeze(metadata);
}

function assertString(value, field) {
  if (typeof value !== "string" || value.trim().length === 0 || [...value].length > maxStringLength) {
    throw new TypeError(`${field} must be a nonempty string of at most ${maxStringLength} characters`);
  }
}

function assertDigest(value, field) {
  if (typeof value !== "string" || !digestPattern.test(value)) {
    throw new TypeError(`${field} must be a lowercase 64-hex digest`);
  }
}

function assertLabel(value, field) {
  if (typeof value !== "string" ||
      (!canonicalLabels.has(value) && !digestPattern.test(value))) {
    throw new TypeError(`${field} must be a canonical label or lowercase 64-hex digest`);
  }
}

function assertISOTimestamp(value, field) {
  assertString(value, field);
  const match = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${field} must be an ISO timestamp`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth) {
    throw new TypeError(`${field} must be an ISO timestamp`);
  }
}

export function createEvent(input) {
  assertPlainObject(input);

  for (const field of Object.keys(input)) {
    if (!allowedFields.has(field)) throw new TypeError(`unknown field: ${field}`);
  }
  for (const field of requiredFields) {
    if (!Object.hasOwn(input, field)) throw new TypeError(`${field} is required`);
  }
  if (input.schemaVersion !== 1) throw new TypeError("schemaVersion must be 1");
  for (const field of ["eventID", "runID", "sessionHMAC", "eventType", "dedupeKey"]) {
    if (digestFields.has(field)) assertDigest(input[field], field);
    else if (labelFields.has(field)) assertLabel(input[field], field);
    else assertString(input[field], field);
  }
  if (!platforms.has(input.platform)) {
    throw new TypeError("platform must be claude, opencode, or codex");
  }
  assertISOTimestamp(input.timestamp, "timestamp");
  if (Object.hasOwn(input, "sequence") &&
      (!Number.isSafeInteger(input.sequence) || input.sequence < 0)) {
    throw new TypeError("sequence must be a nonnegative integer");
  }
  for (const field of optionalStringFields) {
    if (!Object.hasOwn(input, field)) continue;
    if (digestFields.has(field)) assertDigest(input[field], field);
    else if (labelFields.has(field)) assertLabel(input[field], field);
    else assertString(input[field], field);
  }
  let decision;
  if (Object.hasOwn(input, "decision")) {
    decision = createDecision(input.decision);
  }
  // Enforce metrics representation contract:
  // HarnessMetrics REQUIRES summary, non-HarnessMetrics must NOT have summary
  const isHarnessMetrics = input.eventType === "HarnessMetrics";
  if (isHarnessMetrics && !Object.hasOwn(input, "summary")) {
    throw new TypeError("HarnessMetrics events require a summary field");
  }
  if (!isHarnessMetrics && Object.hasOwn(input, "summary")) {
    throw new TypeError("Only HarnessMetrics events may have a summary field");
  }

  let summary;
  if (Object.hasOwn(input, "summary")) {
    assertSummary(input.summary);
    summary = Object.freeze(
      Object.fromEntries(summaryCounterFields.map((field) => [field, input.summary[field]])),
    );
  }

  // Enforce grounding metadata representation contract:
  // metadata is ONLY allowed when eventType === "GroundingInjection".
  const isGroundingInjection = input.eventType === "GroundingInjection";
  if (!isGroundingInjection && Object.hasOwn(input, "metadata")) {
    throw new TypeError("metadata field is not allowed unless eventType is GroundingInjection");
  }

  let metadata;
  if (Object.hasOwn(input, "metadata")) {
    assertGroundingMetadata(input.metadata);
    metadata = freezeGroundingMetadata(input.metadata);
  }

  const event = {};
  for (const field of allowedFields) {
    if (!Object.hasOwn(input, field)) continue;
    if (field === "decision") event[field] = decision;
    else if (field === "summary") event[field] = summary;
    else if (field === "metadata") event[field] = metadata;
    else event[field] = input[field];
  }
  return Object.freeze(event);
}
