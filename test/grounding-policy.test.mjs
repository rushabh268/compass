import { isolateCompassEnvironment } from "./helpers/compass-environment.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

import { loadGroundingConfig } from "../adapters/opencode/grounding.mjs";

const fields = ["schemaVersion", "enabled", "tokenBudget", "deadlineMs", "sources"];
const restoreAliases = isolateCompassEnvironment();
test.after(restoreAliases);
const originalStateDir = process.env.COMPASS_STATE_DIR;
const originalGroundingConfig = process.env.COMPASS_GROUNDING_CONFIG;
const hermeticStateDir = mkdtempSync(join(tmpdir(), "ah-grounding-policy-state-"));
process.env.COMPASS_STATE_DIR = hermeticStateDir;
delete process.env.COMPASS_GROUNDING_CONFIG;
let environmentRestored = false;

function restoreEnvironment() {
  if (environmentRestored) return;
  environmentRestored = true;
  if (originalStateDir === undefined) delete process.env.COMPASS_STATE_DIR;
  else process.env.COMPASS_STATE_DIR = originalStateDir;
  if (originalGroundingConfig === undefined) delete process.env.COMPASS_GROUNDING_CONFIG;
  else process.env.COMPASS_GROUNDING_CONFIG = originalGroundingConfig;
  rmSync(hermeticStateDir, { recursive: true, force: true });
}
process.once("exit", restoreEnvironment);
test.after(restoreEnvironment);

async function readJSON(path) {
  return JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
}

async function loadGroundingValidator() {
  const schema = await readJSON("../config/grounding.schema.json");
  const ajv = new Ajv2020({ allErrors: true, useDefaults: true });
  return { schema, validate: ajv.compile(schema) };
}

function validConfig(overrides = {}) {
  return {
    schemaVersion: 1,
    enabled: true,
    tokenBudget: 256,
    deadlineMs: 100,
    sources: ["project-notes", "repo-comments"],
    ...overrides,
  };
}

function assertDisabled(config) {
  assert.deepEqual(Object.keys(config).sort(), [...fields].sort());
  assert.equal(config.schemaVersion, 1);
  assert.equal(config.enabled, false);
  assert.equal(Number.isInteger(config.tokenBudget), true);
  assert.equal(Number.isInteger(config.deadlineMs), true);
  assert.deepEqual(config.sources, []);
}

async function withEnv(values, operation) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await operation();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("grounding schema is closed and contains exactly the contract fields", async () => {
  const { schema } = await loadGroundingValidator();
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(Object.keys(schema.properties).sort(), [...fields].sort());
  assert.deepEqual(schema.required.sort(), [...fields].sort());
});

test("grounding schema fixes schemaVersion at 1 and defaults enabled to false", async () => {
  const { schema } = await loadGroundingValidator();
  assert.equal(schema.properties.schemaVersion.type, "integer");
  assert.equal(schema.properties.schemaVersion.const, 1);
  assert.equal(schema.properties.enabled.type, "boolean");
  assert.equal(schema.properties.enabled.default, false);
});

test("grounding schema bounds integer budgets and deadlines", async () => {
  const { schema, validate } = await loadGroundingValidator();
  for (const name of ["tokenBudget", "deadlineMs"]) {
    const property = schema.properties[name];
    assert.equal(property.type, "integer");
    assert.equal(Number.isInteger(property.minimum), true);
    assert.equal(Number.isInteger(property.maximum), true);
    assert.ok(property.maximum > property.minimum);
    assert.ok(property.maximum <= (name === "deadlineMs" ? 1_000 : 16_384));
    assert.equal(Number.isInteger(property.default), true);
    assert.equal(validate(validConfig({ [name]: property.maximum })), true);
    assert.equal(validate(validConfig({ [name]: property.maximum + 1 })), false);
    assert.equal(validate(validConfig({ [name]: property.minimum - 1 })), false);
    assert.equal(validate(validConfig({ [name]: property.maximum + 0.5 })), false);
  }
});

test("grounding schema restricts sources to unique enum values", async () => {
  const { schema, validate } = await loadGroundingValidator();
  const sources = schema.properties.sources;
  assert.equal(sources.type, "array");
  assert.equal(sources.uniqueItems, true);
  assert.deepEqual(sources.items.enum.sort(), ["project-notes", "repo-comments"]);
  assert.equal(validate(validConfig({ sources: ["project-notes"] })), true);
  assert.equal(validate(validConfig({ sources: ["project-notes", "project-notes"] })), false);
  assert.equal(validate(validConfig({ sources: ["unknown-source"] })), false);
});

test("grounding schema rejects unknown fields, bad versions, and malformed types", async () => {
  const { validate } = await loadGroundingValidator();
  assert.equal(validate({ ...validConfig(), unknown: true }), false);
  assert.equal(validate({ ...validConfig(), schemaVersion: 2 }), false);
  assert.equal(validate({ ...validConfig(), enabled: "true" }), false);
  assert.equal(validate({ ...validConfig(), tokenBudget: "256" }), false);
  assert.equal(validate({ ...validConfig(), deadlineMs: null }), false);
  assert.equal(validate({ ...validConfig(), sources: "project-notes" }), false);
});

test("example grounding config conforms to the schema", async () => {
  const [{ validate }, example] = await Promise.all([
    loadGroundingValidator(),
    readJSON("../config/grounding.example.json"),
  ]);
  assert.equal(validate(example), true, JSON.stringify(validate.errors));
});

test("runtime missing and malformed configs default to the disabled closed shape", async () => {
  const root = await mkdtemp(join(tmpdir(), "ah-grounding-runtime-invalid-"));
  try {
    assertDisabled(await loadGroundingConfig(join(root, "missing.json")));
    const malformed = join(root, "malformed.json");
    await writeFile(malformed, "{not-json");
    assertDisabled(await loadGroundingConfig(malformed));
    const invalid = join(root, "invalid.json");
    await writeFile(invalid, JSON.stringify({ ...validConfig(), unknown: true }));
    assertDisabled(await loadGroundingConfig(invalid));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime uses the default state-dir path when the env override is clear", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "ah-grounding-runtime-default-"));
  try {
    await writeFile(join(stateDir, "grounding.json"), JSON.stringify(validConfig({ tokenBudget: 321 })));
    const config = await withEnv({
      COMPASS_STATE_DIR: stateDir,
      COMPASS_GROUNDING_CONFIG: undefined,
    }, () => loadGroundingConfig());
    assert.deepEqual(config, validConfig({ tokenBudget: 321 }));
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("runtime env config takes precedence over the default state-dir file", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "ah-grounding-runtime-env-state-"));
  const envDir = await mkdtemp(join(tmpdir(), "ah-grounding-runtime-env-"));
  try {
    await writeFile(join(stateDir, "grounding.json"), JSON.stringify(validConfig({ tokenBudget: 111 })));
    const envPath = join(envDir, "override.json");
    await writeFile(envPath, JSON.stringify(validConfig({ tokenBudget: 222 })));
    const config = await withEnv({
      COMPASS_STATE_DIR: stateDir,
      COMPASS_GROUNDING_CONFIG: envPath,
    }, () => loadGroundingConfig());
    assert.equal(config.tokenBudget, 222);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(envDir, { recursive: true, force: true });
  }
});

test("runtime explicit path wins over both env and default paths", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "ah-grounding-runtime-explicit-state-"));
  const envDir = await mkdtemp(join(tmpdir(), "ah-grounding-runtime-explicit-env-"));
  const explicitDir = await mkdtemp(join(tmpdir(), "ah-grounding-runtime-explicit-arg-"));
  try {
    await writeFile(join(stateDir, "grounding.json"), JSON.stringify(validConfig({ tokenBudget: 111 })));
    const envPath = join(envDir, "override.json");
    const explicitPath = join(explicitDir, "explicit.json");
    await writeFile(envPath, JSON.stringify(validConfig({ tokenBudget: 222 })));
    await writeFile(explicitPath, JSON.stringify(validConfig({ tokenBudget: 333 })));
    const config = await withEnv({
      COMPASS_STATE_DIR: stateDir,
      COMPASS_GROUNDING_CONFIG: envPath,
    }, () => loadGroundingConfig(explicitPath));
    assert.equal(config.tokenBudget, 333);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(envDir, { recursive: true, force: true });
    rmSync(explicitDir, { recursive: true, force: true });
  }
});
