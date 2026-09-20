import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const requiredFields = [
  "schemaVersion",
  "mode",
  "retention",
  "agentBudgets",
  "approvedDestinations",
];

async function readJSON(path) {
  return JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
}

async function loadPolicyValidator() {
  const schema = await readJSON("../config/policy.schema.json");
  const ajv = new Ajv2020({ allErrors: true });
  addFormats(ajv);
  return { schema, validate: ajv.compile(schema) };
}

function destination(origin, operations = ["model"]) {
  return { name: "example", origin, operations };
}

test("policy schema is closed and only permits cooperative mode", async () => {
  const { schema } = await loadPolicyValidator();

  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, requiredFields);
  assert.deepEqual(Object.keys(schema.properties), requiredFields);
  assert.deepEqual(schema.properties.mode.enum, ["cooperative"]);
  assert.equal(schema.properties.mode.default, "cooperative");
  assert.equal(schema.properties.retention.additionalProperties, false);
  assert.equal(schema.properties.agentBudgets.additionalProperties, false);
  assert.equal(schema.properties.approvedDestinations.items.additionalProperties, false);
});

test("example policy is cooperative and conforms to the schema", async () => {
  const [{ validate }, policy] = await Promise.all([
    loadPolicyValidator(),
    readJSON("../config/policy.example.json"),
  ]);

  assert.equal(policy.mode, "cooperative");
  assert.equal(validate(policy), true, JSON.stringify(validate.errors));
});

test("policy rejects unsupported enforced mode", async () => {
  const [{ validate }, policy] = await Promise.all([
    loadPolicyValidator(),
    readJSON("../config/policy.example.json"),
  ]);

  assert.equal(validate({ ...policy, mode: "enforced" }), false);
});

test("policy accepts exact HTTPS origins", async () => {
  const [{ validate }, policy] = await Promise.all([
    loadPolicyValidator(),
    readJSON("../config/policy.example.json"),
  ]);

  for (const origin of [
    "https://example.com",
    "https://example.com:1",
    "https://example.com:65535",
    "https://[2001:db8::1]:443",
  ]) {
    assert.equal(
      validate({ ...policy, approvedDestinations: [destination(origin)] }),
      true,
      `${origin}: ${JSON.stringify(validate.errors)}`,
    );
  }
});

test("policy rejects destinations that are not exact HTTPS origins", async () => {
  const [{ validate }, policy] = await Promise.all([
    loadPolicyValidator(),
    readJSON("../config/policy.example.json"),
  ]);
  const malformedOrigins = [
    "https://user@example.com",
    "https://example.com/path",
    "https://example.com?query=value",
    "https://example.com#fragment",
    "https://example.com:0",
    "https://example.com:65536",
  ];

  for (const origin of malformedOrigins) {
    assert.equal(
      validate({ ...policy, approvedDestinations: [destination(origin)] }),
      false,
      `${origin} should be rejected`,
    );
  }
});

test("policy rejects invalid agent budgets", async () => {
  const [{ validate }, policy] = await Promise.all([
    loadPolicyValidator(),
    readJSON("../config/policy.example.json"),
  ]);

  for (const agentBudgets of [
    { ...policy.agentBudgets, maxConcurrent: 0 },
    { ...policy.agentBudgets, maxChildren: -1 },
    { ...policy.agentBudgets, maxDepth: -1 },
  ]) {
    assert.equal(validate({ ...policy, agentBudgets }), false);
  }
});

test("policy rejects unknown destination operations", async () => {
  const [{ validate }, policy] = await Promise.all([
    loadPolicyValidator(),
    readJSON("../config/policy.example.json"),
  ]);

  assert.equal(
    validate({
      ...policy,
      approvedDestinations: [destination("https://example.com", ["shell"])],
    }),
    false,
  );
});

test("security docs identify cooperative mode as bypassable by same-UID agents", async () => {
  const [threatModel, enforcementMatrix] = await Promise.all([
    readFile(new URL("../docs/threat-model.md", import.meta.url), "utf8"),
    readFile(new URL("../docs/enforcement-matrix.md", import.meta.url), "utf8"),
  ]);

  const disclaimer = "Cooperative mode is not a same-UID security boundary.";
  assert.ok(threatModel.includes(disclaimer));
  assert.ok(enforcementMatrix.includes(disclaimer));
});

test("threat model documents cooperative rollback detection limits", async () => {
  const threatModel = await readFile(
    new URL("../docs/threat-model.md", import.meta.url),
    "utf8",
  );

  assert.match(
    threatModel,
    /Cooperative mode cannot detect rollback of the (?:database|DB) together with its local commitments\./,
  );
});

test("security fixtures are documented as synthetic and secret-free", async () => {
  const fixtureReadme = await readFile(
    new URL("./fixtures/security/README.md", import.meta.url),
    "utf8",
  );

  assert.match(fixtureReadme, /synthetic/i);
  assert.match(fixtureReadme, /never contain live credentials/i);
});
