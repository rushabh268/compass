import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { checkSyntax, enumerateJavaScriptFiles } from "../scripts/check-syntax.mjs";

test("recursively enumerates JavaScript files and handles spaces", async () => {
  const root = await mkdtemp(join(tmpdir(), "syntax files "));
  await mkdir(join(root, "nested folder"));
  await writeFile(join(root, "first.mjs"), "export const first = true;\n");
  await writeFile(join(root, "nested folder", "second.js"), "export const second = true;\n");
  await writeFile(join(root, "nested folder", "ignored.txt"), "not JavaScript\n");

  assert.deepEqual(await enumerateJavaScriptFiles([root]), [
    join(root, "first.mjs"),
    join(root, "nested folder", "second.js"),
  ]);
  await assert.doesNotReject(() => checkSyntax([root]));
});

test("fails when the second discovered file has broken syntax", async () => {
  const root = await mkdtemp(join(tmpdir(), "syntax-broken-"));
  await writeFile(join(root, "a-valid.mjs"), "export const valid = true;\n");
  await writeFile(join(root, "b-broken.mjs"), "export const broken = ;\n");

  await assert.rejects(() => checkSyntax([root]), /b-broken\.mjs/);
});
