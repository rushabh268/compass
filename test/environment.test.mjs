import assert from "node:assert/strict";
import test from "node:test";
import { environmentValue } from "../src/environment.mjs";

for (const name of ["SOCKET", "KEY_FILE", "STATE_DIR", "COALESCING_CONFIG", "GROUNDING_CONFIG", "NOTES_DIR"]) {
  test(`${name}: Compass overrides legacy while legacy remains usable`, () => {
    assert.equal(environmentValue(name, {}), undefined);
    assert.equal(environmentValue(name, { [`AGENT_HARNESS_${name}`]: "old" }), "old");
    assert.equal(environmentValue(name, { [`COMPASS_${name}`]: "new", [`AGENT_HARNESS_${name}`]: "old" }), "new");
    assert.equal(environmentValue(name, { [`COMPASS_${name}`]: "", [`AGENT_HARNESS_${name}`]: "old" }), "");
    assert.equal(environmentValue(name, { [`COMPASS_${name}`]: "/invalid", [`AGENT_HARNESS_${name}`]: "old" }), "/invalid");
  });
}

// Exercise real loaders, so a correctly named helper unused by its consumers
// cannot make legacy compatibility appear to work.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGroundingConfig } from "../src/grounding.mjs";
import { loadCoalescingConfig } from "../adapters/opencode/coalescer.mjs";

test("policy loaders honor legacy values and never fall back past explicit Compass paths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "compass-policy-alias-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const names = ["STATE_DIR", "GROUNDING_CONFIG", "COALESCING_CONFIG"];
  const keys = names.flatMap((name) => [`COMPASS_${name}`, `AGENT_HARNESS_${name}`]);
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  for (const key of keys) delete process.env[key];
  await writeFile(join(root, "grounding.json"), JSON.stringify({ schemaVersion: 1, enabled: true, tokenBudget: 256, deadlineMs: 100, sources: ["project-notes"] }));
  await writeFile(join(root, "coalescing.json"), JSON.stringify({ schemaVersion: 1, enabled: true, windowMs: 600000, queueMax: 256, preserveLabels: ["lifecycle", "tool", "permission", "error"], dlpOverride: true }));
  process.env.AGENT_HARNESS_STATE_DIR = root;
  for (const [name, loader, file] of [["GROUNDING_CONFIG", loadGroundingConfig, "grounding.json"], ["COALESCING_CONFIG", loadCoalescingConfig, "coalescing.json"]]) {
    assert.equal((await loader()).enabled, true);
    process.env[`AGENT_HARNESS_${name}`] = join(root, file);
    for (const value of ["", join(root, "missing.json")]) {
      process.env[`COMPASS_${name}`] = value;
      assert.equal((await loader()).enabled, false);
      assert.equal((await loader(join(root, file))).enabled, true);
    }
    delete process.env[`COMPASS_${name}`];
    assert.equal((await loader()).enabled, true);
  }
});
