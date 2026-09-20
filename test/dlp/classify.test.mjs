import assert, { AssertionError } from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { scanText } from "../../src/dlp/classify.mjs";
import { loadSyntheticFixtures } from "../fixtures/dlp/load.mjs";

const fixture = await loadSyntheticFixtures();

test("synthetic fixture loader preserves every detection input byte", () => {
  assert.equal(fixture.detections.length, 68);
  const textCorpus = JSON.stringify(fixture.detections.map(({ text }) => text));
  assert.equal(createHash("sha256").update(textCorpus).digest("hex"),
    "d16055f61a38306dae4f7479d1d07cc9fb04e40abe58f84804491fbc112ba6ba");
  assert.ok(fixture.detections.every((example) => !Object.hasOwn(example, "textParts")));
});

for (const example of fixture.detections) {
  test(`scanText detects synthetic ${example.name}`, () => {
    assert.deepEqual(scanText(example.text, { source: "fixture.txt" }), [
      {
        ruleID: example.ruleID,
        source: "sha256:8753fcfdb2eea78a",
        line: example.line,
        column: example.column,
      },
    ]);
  });
}

test("scanText omits source and secret material from findings", () => {
  const example = fixture.detections[0];
  const findings = scanText(example.text);

  assert.deepEqual(findings, [
    {
      ruleID: example.ruleID,
      line: example.line,
      column: example.column,
    },
  ]);
  assert.deepEqual(Object.keys(findings[0]), ["ruleID", "line", "column"]);
  assert.ok(!JSON.stringify(findings).includes("b7Qx_2mN9"));
});

test("scanText redacts source metadata containing a credential", () => {
  const textSecret = "b7Qx_2mN9-vR4.kL8sP0";
  const sourceSecret = "N7v-qR2-kL9-pX4";
  const findings = scanText(`Authorization: Bearer ${textSecret}`, {
    source: `logs/password=${sourceSecret}`,
  });

  assert.equal(findings[0].ruleID, "bearer-token");
  assert.match(findings[0].source, /^sha256:[0-9a-f]{16}$/);
  assert.equal(findings[0].line, 1);
  assert.equal(findings[0].column, 23);
  assert.ok(!JSON.stringify(findings).includes(textSecret));
  assert.ok(!JSON.stringify(findings).includes(sourceSecret));
});

test("scanText redacts source metadata containing URL credentials", () => {
  const sourceSecret = "N7v-qR2-kL9-pX4";
  const findings = scanText("Authorization: Bearer b7Qx_2mN9-vR4.kL8sP0", {
    source: `https://alice:${sourceSecret}@example.com/report`,
  });

  assert.match(findings[0].source, /^sha256:[0-9a-f]{16}$/);
  assert.ok(!JSON.stringify(findings).includes(sourceSecret));
});

test("scanText represents sensitive source metadata with a deterministic hash", () => {
  const source = "logs/password=N7v-qR2-kL9-pX4";
  const text = "Authorization: Bearer b7Qx_2mN9-vR4.kL8sP0";
  const first = scanText(text, { source })[0].source;
  const second = scanText(text, { source })[0].source;

  assert.equal(first, second);
  assert.match(first, /^sha256:[0-9a-f]{16}$/);
  assert.ok(!first.includes("N7v-qR2-kL9-pX4"));
});

test("scanText represents every supplied source with a deterministic hash", () => {
  const text = "Authorization: Bearer b7Qx_2mN9-vR4.kL8sP0";

  for (const [source, expected] of [
    ["fixture.txt", "sha256:8753fcfdb2eea78a"],
    ["logs/password=N7v-qR2-kL9-pX4", "sha256:bb6fffa5dc43a253"],
    [
      "https://alice:N7v-qR2-kL9-pX4@example.com/report",
      "sha256:bf264fc809ad2e2b",
    ],
  ]) {
    assert.equal(scanText(text, { source })[0].source, expected);
  }
});

test("scanText preserves every finding contributing to an overlapping range", () => {
  assert.deepEqual(
    scanText("GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz1234567890", {
      source: "fixture.txt",
    }),
    [
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
  );
  assert.deepEqual(
    scanText("token=glsa_QWxwaGFCZXRhR2FtbWFEZWx0YQ"),
    [
      { ruleID: "credential-assignment", line: 1, column: 7 },
      { ruleID: "grafana-token", line: 1, column: 7 },
    ],
  );
});

test("scanText ignores placeholders and obvious example values", () => {
  assert.deepEqual(scanText(fixture.safeExamples.join("\n")), []);
});

test("credential assignment key drift guard preserves intended classifications", () => {
  for (const key of fixture.credentialKeyDriftGuard.accepted) {
    assert.deepEqual(scanText(`${key}=synthetic-value`), [
      { ruleID: "credential-assignment", line: 1, column: key.length + 2 },
    ], `expected ${key} to be sensitive`);
  }
  for (const key of fixture.credentialKeyDriftGuard.rejected) {
    assert.deepEqual(scanText(`${key}=synthetic-value`), [], `expected ${key} to be safe`);
  }
});

for (const [name, text, ruleID, column] of [
  ["short Basic credentials", "Authorization: Basic YTpi", "basic-auth", 22],
  ["short Bearer credentials", "Authorization: Bearer abc", "bearer-token", 23],
  ["malformed Basic credentials", "Authorization: Basic YWxpY2U6A", "basic-auth", 22],
]) {
  test(`scanText detects ${name} in explicit auth contexts`, () => {
    assert.deepEqual(scanText(text), [{ ruleID, line: 1, column }]);
  });
}

test("scanText ignores empty auth schemes and structural placeholders", () => {
  for (const text of [
    "Authorization: Basic",
    "Authorization: Bearer",
    "Authorization: Basic ${BASIC_AUTH}",
    "Authorization: Bearer {env:TOKEN}",
    "Authorization: Basic <redacted>",
    "Authorization: Bearer [REDACTED:bearer-token]",
  ]) {
    assert.deepEqual(scanText(text), []);
  }
});

test("scanText stops URL authority at query and fragment delimiters", () => {
  const text = [
    "https://db.internal?contact=alice:S3cur3-p4ss@corp.internal",
    "https://db.internal#contact=alice:S3cur3-p4ss@corp.internal",
    "https://db.internal\\contact=alice:S3cur3-p4ss@corp.internal",
  ].join("\n");

  assert.deepEqual(scanText(text), []);
});

test("scanText reports coordinates after CRLF line endings", () => {
  assert.deepEqual(scanText("first\r\nsecond\r\n🔐 password=N7v-qR2-kL9-pX4"), [
    {
      ruleID: "credential-assignment",
      line: 3,
      column: 12,
    },
  ]);
});

test("scanText rejects non-string input", () => {
  for (const value of [undefined, null, 42, {}, []]) {
    assert.throws(() => scanText(value), {
      name: "TypeError",
      message: "text must be a string",
    });
  }
});

test("scanText neither mutates nor logs its input", () => {
  const text = fixture.detections[0].text;
  const originalText = text;
  const options = Object.freeze({ source: "fixture.txt" });
  const methods = ["debug", "error", "info", "log", "warn"];
  const originals = new Map(methods.map((method) => [method, console[method]]));
  let logged = false;

  for (const method of methods) console[method] = () => { logged = true; };
  try {
    scanText(text, options);
  } finally {
    for (const [method, original] of originals) console[method] = original;
  }

  assert.equal(text, originalText);
  assert.equal(logged, false);
});

// Negative test cases: patterns that should NOT be detected as credentials
for (const example of fixture.negativeExamples) {
  test(`scanText ignores negative case: ${example.name}`, () => {
    const findings = scanText(example.text);
    assert.deepEqual(findings, [], `${example.name}: ${example.should}`);
  });
}

// Labeled corpus: high-precision detections with 100% recall and 0% FP requirement
test("labeled corpus: all positive cases must be detected", () => {
  const corpus = fixture.labeledCorpusCases;
  let detectedCount = 0;

  for (const example of corpus.positives) {
    const findings = scanText(example.text);
    if (findings.length === 0) {
      throw new AssertionError({
        message: `MISSING DETECTION: ${example.name}`,
        actual: findings,
        expected: [{ ruleID: example.ruleID }],
      });
    }
    assert.deepEqual(findings[0].ruleID, example.ruleID, `${example.name} should be detected as ${example.ruleID}`);
    detectedCount += 1;
  }

  assert.equal(detectedCount, corpus.positives.length, `100% recall: ${detectedCount}/${corpus.positives.length}`);
});

test("labeled corpus: all negative cases must NOT be detected", () => {
  const corpus = fixture.labeledCorpusCases;
  let negativeCount = 0;

  for (const example of corpus.negatives) {
    const findings = scanText(example.text);
    if (findings.length > 0) {
      throw new AssertionError({
        message: `FALSE POSITIVE: ${example.name}`,
        actual: findings,
        expected: [],
      });
    }
    negativeCount += 1;
  }

  assert.equal(negativeCount, corpus.negatives.length, `0% FP: ${negativeCount}/${corpus.negatives.length} negative cases correctly ignored`);
});

// Individual labeled corpus positive detections
for (const example of fixture.labeledCorpusCases.positives) {
  test(`labeled corpus positive: ${example.name}`, () => {
    const findings = scanText(example.text);
    assert.ok(findings.length > 0, `${example.name} should be detected`);
    assert.equal(findings[0].ruleID, example.ruleID, `${example.name} ruleID should be ${example.ruleID}`);
  });
}

// Individual labeled corpus negative detections
for (const example of fixture.labeledCorpusCases.negatives) {
  test(`labeled corpus negative: ${example.name} - must not trigger false positive`, () => {
    const findings = scanText(example.text);
    assert.deepEqual(findings, [], `${example.name} should NOT be detected`);
  });
}
