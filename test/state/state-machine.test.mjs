import assert from "node:assert/strict";
import test from "node:test";

import { assertTransition } from "../../src/state/state-machine.mjs";

test("accepts the cooperative lifecycle and rework loop", () => {
  for (const [current, next] of [
    ["CREATED", "ADMITTED"],
    ["ADMITTED", "ACTIVE"],
    ["ACTIVE", "SNAPSHOTTED"],
    ["SNAPSHOTTED", "REVIEWING"],
    ["REVIEWING", "VALIDATING"],
    ["VALIDATING", "VERIFIED_TREE"],
    ["REVIEWING", "REWORKING"],
    ["VALIDATING", "REWORKING"],
    ["VERIFIED_TREE", "REWORKING"],
    ["REWORKING", "SNAPSHOTTED"],
  ]) {
    assert.doesNotThrow(() => assertTransition(current, next));
  }
});

test("allows terminal transitions from every nonterminal state", () => {
  for (const current of [
    "CREATED", "ADMITTED", "ACTIVE", "SNAPSHOTTED", "REVIEWING",
    "VALIDATING", "VERIFIED_TREE", "REWORKING",
  ]) {
    assert.doesNotThrow(() => assertTransition(current, "FAILED"));
    assert.doesNotThrow(() => assertTransition(current, "CANCELLED"));
  }
});

test("rejects illegal, terminal, and unknown transitions", () => {
  for (const [current, next] of [
    ["CREATED", "ACTIVE"],
    ["REWORKING", "ACTIVE"],
    ["FAILED", "CREATED"],
    ["CANCELLED", "FAILED"],
    ["UNKNOWN", "CREATED"],
    ["CREATED", "UNKNOWN"],
  ]) {
    assert.throws(() => assertTransition(current, next), /transition/i);
  }
});
