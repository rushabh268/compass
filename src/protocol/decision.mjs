import { types } from "node:util";

const allowedFields = new Set(["schemaVersion", "action", "ruleIDs", "reason", "expiresAt"]);
const actions = new Set(["observe", "allow", "block"]);
const maxStringLength = 1024;
const maxRuleIDs = 64;
const ruleIDPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

function assertPlainObject(value) {
  if (value === null || typeof value !== "object" || types.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError("decision must be a plain JSON object");
  }
  for (const field of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (typeof field !== "string" || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError("decision must be a plain JSON object");
    }
  }
}

function assertString(value, field) {
  if (typeof value !== "string" || value.trim().length === 0 || [...value].length > maxStringLength) {
    throw new TypeError(`${field} must be a nonempty string of at most ${maxStringLength} characters`);
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

function snapshotRuleIDs(value) {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`ruleIDs must contain 1-${maxRuleIDs} unique non-secret identifiers`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string" || (key !== "length" && !/^(?:0|[1-9]\d*)$/.test(key)))) {
    throw new TypeError(`ruleIDs must contain 1-${maxRuleIDs} unique non-secret identifiers`);
  }
  const length = descriptors.length.value;
  const snapshot = new Array(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[index];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`ruleIDs must contain 1-${maxRuleIDs} unique non-secret identifiers`);
    }
    snapshot[index] = descriptor.value;
  }
  return snapshot;
}

export function createDecision(input) {
  assertPlainObject(input);

  for (const field of Object.keys(input)) {
    if (!allowedFields.has(field)) throw new TypeError(`unknown field: ${field}`);
  }
  for (const field of ["schemaVersion", "action", "ruleIDs", "reason"]) {
    if (!Object.hasOwn(input, field)) throw new TypeError(`${field} is required`);
  }
  if (input.schemaVersion !== 1) throw new TypeError("schemaVersion must be 1");
  if (!actions.has(input.action)) {
    throw new TypeError("action must be observe, allow, or block");
  }
  const ruleIDs = snapshotRuleIDs(input.ruleIDs);
  if (ruleIDs.length === 0 || ruleIDs.length > maxRuleIDs ||
      new Set(ruleIDs).size !== ruleIDs.length ||
      ruleIDs.some((ruleID) => typeof ruleID !== "string" || !ruleIDPattern.test(ruleID))) {
    throw new TypeError(`ruleIDs must contain 1-${maxRuleIDs} unique non-secret identifiers`);
  }
  assertString(input.reason, "reason");
  if (scanText(input.reason).length > 0) throw new TypeError("reason must not contain secrets");
  if (Object.hasOwn(input, "expiresAt")) assertISOTimestamp(input.expiresAt, "expiresAt");

  const decision = {
    schemaVersion: input.schemaVersion,
    action: input.action,
    ruleIDs: Object.freeze(ruleIDs),
    reason: input.reason,
  };
  if (Object.hasOwn(input, "expiresAt")) decision.expiresAt = input.expiresAt;
  return Object.freeze(decision);
}
import { scanText } from "../dlp/classify.mjs";
