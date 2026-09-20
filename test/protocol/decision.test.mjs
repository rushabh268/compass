import assert from "node:assert/strict";
import test from "node:test";

import { createDecision } from "../../src/protocol/decision.mjs";

const required = {
  schemaVersion: 1,
  action: "observe",
  ruleIDs: ["dlp.bearer-token"],
  reason: "Credential-shaped content was observed",
};

test("createDecision supports every action and optional expiry", () => {
  for (const action of ["observe", "allow", "block"]) {
    const input = { ...required, action, expiresAt: "2026-08-25T12:34:56.000Z" };
    assert.deepEqual(createDecision(input), input);
  }
});

test("createDecision returns a deeply frozen plain JSON object", () => {
  const input = { ...required, ruleIDs: [...required.ruleIDs] };
  const decision = createDecision(input);

  assert.notEqual(decision, input);
  assert.notEqual(decision.ruleIDs, input.ruleIDs);
  assert.equal(Object.getPrototypeOf(decision), Object.prototype);
  assert.equal(Object.isFrozen(decision), true);
  assert.equal(Object.isFrozen(decision.ruleIDs), true);
  assert.throws(() => { decision.action = "allow"; }, TypeError);
  assert.throws(() => decision.ruleIDs.push("other"), TypeError);
});

test("createDecision survives a JSON round trip", () => {
  const decision = createDecision(JSON.parse(JSON.stringify(required)));
  assert.deepEqual(JSON.parse(JSON.stringify(decision)), required);
});

test("createDecision rejects non-plain inputs, unknown fields, and raw details", () => {
  class DecisionInput {}
  for (const input of [null, [], new DecisionInput(), Object.create(null)]) {
    assert.throws(() => createDecision(input), TypeError);
  }
  assert.throws(() => createDecision({ ...required, details: { prompt: "secret" } }), /unknown field/i);
  assert.throws(() => createDecision({ ...required, rawDetails: "secret" }), /unknown field/i);
});

test("createDecision rejects properties that plain JSON cannot represent", () => {
  const withSymbol = { ...required, [Symbol("details")]: "secret" };
  const withAccessor = { ...required };
  Object.defineProperty(withAccessor, "reason", { enumerable: true, get: () => "safe" });

  assert.throws(() => createDecision(withSymbol), /plain JSON object/);
  assert.throws(() => createDecision(withAccessor), /plain JSON object/);
});

test("createDecision rejects enclosing proxies that change after validation", () => {
  let reads = 0;
  const proxied = new Proxy({ ...required }, {
    get(target, property, receiver) {
      if (property === "action" && ++reads > 1) return { rawPrompt: "secret" };
      return Reflect.get(target, property, receiver);
    },
  });

  assert.throws(() => createDecision(proxied), /plain JSON object/);
});

test("createDecision requires its fields and schemaVersion 1", () => {
  for (const field of ["schemaVersion", "action", "ruleIDs", "reason"]) {
    const input = { ...required };
    delete input[field];
    assert.throws(() => createDecision(input), new RegExp(field));
  }
  for (const schemaVersion of [0, 2, "1"]) {
    assert.throws(() => createDecision({ ...required, schemaVersion }), /schemaVersion/);
  }
});

test("createDecision rejects unknown actions", () => {
  for (const action of ["prompt", "deny", "ALLOW", ""]) {
    assert.throws(() => createDecision({ ...required, action }), /action/);
  }
});

test("createDecision validates non-secret bounded rule IDs and reason", () => {
  for (const ruleIDs of [[], "rule", [""], [42], ["x".repeat(1025)], ["rule", "rule"]]) {
    assert.throws(() => createDecision({ ...required, ruleIDs }), /ruleIDs/);
  }
  for (const reason of ["", "   ", 42, "x".repeat(1025)]) {
    assert.throws(() => createDecision({ ...required, reason }), /reason/);
  }
  assert.throws(
    () => createDecision({ ...required, ruleIDs: ["Authorization: Bearer abc"] }),
    /ruleIDs/,
  );
  assert.throws(
    () => createDecision({ ...required, reason: "Authorization: Bearer abc" }),
    /reason/,
  );
});

test("createDecision rejects accessor ruleIDs arrays", () => {
  const withAccessor = ["dlp.bearer-token"];
  Object.defineProperty(withAccessor, 0, {
    enumerable: true,
    get: () => "dlp.bearer-token",
  });

  assert.throws(() => createDecision({ ...required, ruleIDs: withAccessor }), /ruleIDs/);
});

test("createDecision rejects proxy ruleIDs arrays that change after validation", () => {
  let reads = 0;
  const proxied = new Proxy(["dlp.bearer-token"], {
    get(target, property, receiver) {
      if (property === "0" && ++reads > 2) return "Authorization: Bearer abc";
      return Reflect.get(target, property, receiver);
    },
  });

  assert.throws(() => createDecision({ ...required, ruleIDs: proxied }), /ruleIDs/);
});

test("createDecision rejects ruleIDs arrays with malformed prototypes", () => {
  const customPrototype = Object.create(Array.prototype);
  const ruleIDs = ["dlp.bearer-token"];
  Object.setPrototypeOf(ruleIDs, customPrototype);

  assert.throws(() => createDecision({ ...required, ruleIDs }), /ruleIDs/);
});

test("createDecision bounds strings by Unicode code points", () => {
  assert.equal(createDecision({ ...required, reason: "😀".repeat(1024) }).reason, "😀".repeat(1024));
  assert.throws(() => createDecision({ ...required, reason: "😀".repeat(1025) }), /reason/);
});

test("createDecision validates expiresAt as an ISO timestamp", () => {
  for (const expiresAt of ["2026-08-25", "later", "2026-02-30T00:00:00Z", 42]) {
    assert.throws(() => createDecision({ ...required, expiresAt }), /expiresAt/);
  }
});

test("createDecision validates ISO dates in year 0000", () => {
  assert.equal(
    createDecision({ ...required, expiresAt: "0000-02-29T00:00:00Z" }).expiresAt,
    "0000-02-29T00:00:00Z",
  );
  assert.throws(
    () => createDecision({ ...required, expiresAt: "0000-02-30T00:00:00Z" }),
    /expiresAt/,
  );
});
