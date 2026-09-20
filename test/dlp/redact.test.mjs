import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";

import { scanText } from "../../src/dlp/classify.mjs";
import { redactText } from "../../src/dlp/redact.mjs";
import { loadSyntheticFixtures } from "../fixtures/dlp/load.mjs";

const fixture = await loadSyntheticFixtures();

for (const example of fixture.detections) {
  test(`redactText redacts synthetic ${example.name}`, () => {
    assert.deepEqual(redactText(example.text, { source: "fixture.txt" }), {
      text: example.redacted,
      findings: [
        {
          ruleID: example.ruleID,
          source: "sha256:8753fcfdb2eea78a",
          line: example.line,
          column: example.column,
        },
      ],
    });
  });
}

test("redactText leaves placeholders and obvious example values unchanged", () => {
  const text = fixture.safeExamples.join("\n");

  assert.deepEqual(redactText(text), { text, findings: [] });
});

for (const [name, text, redacted, ruleID, column] of [
  ["short Basic credentials", "Authorization: Basic YTpi", "Authorization: Basic [REDACTED:basic-auth]", "basic-auth", 22],
  ["short Bearer credentials", "Authorization: Bearer abc", "Authorization: Bearer [REDACTED:bearer-token]", "bearer-token", 23],
  ["malformed Basic credentials", "Authorization: Basic YWxpY2U6A", "Authorization: Basic [REDACTED:basic-auth]", "basic-auth", 22],
]) {
  test(`redactText redacts ${name} in explicit auth contexts`, () => {
    assert.deepEqual(redactText(text), {
      text: redacted,
      findings: [{ ruleID, line: 1, column }],
    });
  });
}

test("redactText leaves empty auth schemes and structural placeholders unchanged", () => {
  for (const text of [
    "Authorization: Basic",
    "Authorization: Bearer",
    "Authorization: Basic ${BASIC_AUTH}",
    "Authorization: Bearer {env:TOKEN}",
    "Authorization: Basic <redacted>",
    "Authorization: Bearer [REDACTED:bearer-token]",
  ]) {
    assert.deepEqual(redactText(text), { text, findings: [] });
  }
});

test("redactText merges partially overlapping findings by union", () => {
  const secret = "A9f-kL3_pQ7-mN2";
  const result = redactText(`https://token=${secret}@db.internal`);

  assert.deepEqual(result, {
    text: "https://[REDACTED:url-userinfo]",
    findings: [{ ruleID: "url-userinfo", line: 1, column: 9 }],
  });
  assert.ok(!JSON.stringify(result).includes(secret));
});

test("redactText preserves overlapping assignment and typed-token findings in one union", () => {
  assert.deepEqual(
    redactText("GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz1234567890", {
      source: "fixture.txt",
    }),
    {
      text: "GITHUB_TOKEN=[REDACTED:credential-assignment]",
      findings: [
        {
          ruleID: "credential-assignment",
          source: "sha256:8753fcfdb2eea78a",
          line: 1,
          column: 14,
        },
        {
          ruleID: "github-token",
          source: "sha256:8753fcfdb2eea78a",
          line: 1,
          column: 14,
        },
      ],
    },
  );
  assert.deepEqual(
    redactText("token=glsa_QWxwaGFCZXRhR2FtbWFEZWx0YQ"),
    {
      text: "token=[REDACTED:credential-assignment]",
      findings: [
        { ruleID: "credential-assignment", line: 1, column: 7 },
        { ruleID: "grafana-token", line: 1, column: 7 },
      ],
    },
  );
});

test("redactText rejects non-string input", () => {
  for (const value of [undefined, null, 42, {}, []]) {
    assert.throws(() => redactText(value), {
      name: "TypeError",
      message: "text must be a string",
    });
  }
});

test("scanText and redactText process 8,000 findings within a CI-safe budget", () => {
  const findingCount = 8_000;
  const padding = "x".repeat(256);
  const text = Array.from(
    { length: findingCount },
    (_, index) => `${padding} secret=value-${index}-A9f_kL3-pQ7`,
  ).join("\n");
  const startedAt = performance.now();

  const findings = scanText(text);
  const result = redactText(text);
  const elapsed = performance.now() - startedAt;

  assert.equal(findings.length, findingCount);
  assert.equal(result.findings.length, findingCount);
  assert.equal(result.text.match(/\[REDACTED:credential-assignment\]/g)?.length, findingCount);
  assert.ok(elapsed < 2_000, `8,000 findings took ${elapsed.toFixed(1)}ms`);
});

test("scanText handles long-whitespace non-assignments within an aggregate budget", () => {
  const text = `password${" ".repeat(250_000)}not-an-assignment`;
  const startedAt = performance.now();

  for (let scan = 0; scan < 100; scan += 1) {
    assert.deepEqual(scanText(text), []);
  }
  const elapsed = performance.now() - startedAt;

  assert.ok(elapsed < 1_000, `100 long-whitespace scans took ${elapsed.toFixed(1)}ms`);
});

test("redactText neither mutates nor logs its input", () => {
  const input = fixture.detections.map(({ text }) => text).join("\n");
  const originalInput = input;
  const options = Object.freeze({ source: "fixture.txt" });
  const methods = ["debug", "error", "info", "log", "warn"];
  const originals = new Map(methods.map((method) => [method, console[method]]));
  let logged = false;
  let result;

  for (const method of methods) console[method] = () => { logged = true; };
  try {
    result = redactText(input, options);
  } finally {
    for (const [method, original] of originals) console[method] = original;
  }

  assert.equal(input, originalInput);
  assert.notEqual(result.text, input);
  assert.equal(logged, false);
});

// Verify redaction for negative cases (should pass through unchanged)
test("redactText leaves negative cases unchanged", () => {
  for (const example of fixture.negativeExamples) {
    const result = redactText(example.text);
    assert.equal(result.text, example.text, `${example.name} should not be modified`);
    assert.deepEqual(result.findings, [], `${example.name} should have no findings`);
  }
});

// Labeled corpus: verify redaction correctness
test("labeled corpus: all positive cases must be redacted", () => {
  const corpus = fixture.labeledCorpusCases;
  let redactedCount = 0;

  for (const example of corpus.positives) {
    const result = redactText(example.text);
    assert.ok(result.findings.length > 0, `${example.name} should have findings`);
    assert.ok(
      result.text.includes("[REDACTED:"),
      `${example.name} text should contain redaction marker`
    );
    // Verify text changed (redaction occurred) - not a byte-for-byte comparison
    // since we preserve keys (e.g., Cookie: sessionId= remains)
    assert.ok(
      result.text !== example.text,
      `${example.name} should be redacted (text should differ from original)`
    );
    redactedCount += 1;
  }

  assert.equal(redactedCount, corpus.positives.length, `All ${corpus.positives.length} positives redacted`);
});

// Verify negative cases remain unchanged during redaction
for (const example of fixture.labeledCorpusCases.negatives) {
  test(`labeled corpus redaction negative: ${example.name} - must not be modified`, () => {
    const result = redactText(example.text);
    assert.equal(result.text, example.text, `${example.name} should remain unchanged`);
    assert.deepEqual(result.findings, [], `${example.name} should have no findings`);
  });
}
