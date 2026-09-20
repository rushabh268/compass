import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtemp,
  rm,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
test("reader-key provisioning writes only explicit companion state and preserves keys", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "compass-key-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "native-home");
  await writeFile(home, "native untouched");
  const dir = join(root, "compass");
  const args = ["src/cli.mjs", "reader-key", "--state-dir", dir];
  await exec(process.execPath, args, { env: { ...process.env, HOME: home } });
  const first = await readFile(join(dir, "reader.key"));
  assert.equal(first.length, 32);
  assert.equal((await stat(join(dir, "reader.key"))).mode & 0o777, 0o600);
  await exec(process.execPath, args, { env: { ...process.env, HOME: home } });
  assert.deepEqual(await readFile(join(dir, "reader.key")), first);
  assert.deepEqual((await readdir(root)).sort(), ["compass", "native-home"]);
  assert.equal(await readFile(home, "utf8"), "native untouched");
});
