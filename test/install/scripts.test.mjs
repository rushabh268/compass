import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "..", "..");
const scripts = ["install.sh", "uninstall.sh"];

function readScript(name) {
  const path = join(repoRoot, name);
  assert.doesNotThrow(() => statSync(path), `${name} must exist at the repository root`);
  return { name, path, text: readFileSync(path, "utf8") };
}

function assertPortableShellScript(script) {
  assert.match(script.text, /^(#!\/bin\/sh|#!\/usr\/bin\/env sh)(?:\r?\n|$)/, `${script.name} must start with a POSIX shell shebang`);
  assert.notEqual(statSync(script.path).mode & 0o100, 0, `${script.name} must be executable by its owner`);
  assert.doesNotThrow(
    () => execFileSync("sh", ["-n", script.path], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
    `${script.name} must pass sh -n without stderr`,
  );
}

function assertMacOSGuard(script) {
  assert.match(script.text, /uname/, `${script.name} must inspect the operating system with uname`);
  assert.match(script.text, /Darwin/, `${script.name} must check for Darwin`);
  assert.match(script.text, /exit\s+[1-9]/, `${script.name} must exit when the platform is unsupported`);
}

function assertResolvedInstallEntry(script, entry) {
  assert.match(script.text, /dirname/, `${script.name} must use dirname to resolve its own directory`);
  assert.match(script.text, /\$0|\$\{0\}/, `${script.name} must resolve its own directory from $0`);
  assert.match(
    script.text,
    new RegExp(`\\$\\{?[A-Za-z_][A-Za-z0-9_]*\\}?/install/${entry}\\.mjs`),
    `${script.name} must invoke install/${entry}.mjs through its resolved directory variable`,
  );
}

test("install.sh and uninstall.sh are executable, valid POSIX shell, and have the required shebang", () => {
  for (const name of scripts) assertPortableShellScript(readScript(name));
});

test("install.sh and uninstall.sh guard against non-macOS platforms", () => {
  for (const name of scripts) assertMacOSGuard(readScript(name));
});

test("install.sh invokes the pinned bootstrap and forwards all arguments", () => {
  const script = readScript("install.sh");

  assert.match(script.text, /npx/, "install.sh must invoke the bootstrap with npx");
  assert.match(script.text, /node@24\.19\.0/, "install.sh must pin Node to 24.19.0");
  assert.match(script.text, /install\/bootstrap\.mjs/, "install.sh must reference install/bootstrap.mjs");
  assert.match(script.text, /"\$@"/, "install.sh must forward all arguments");
  assertResolvedInstallEntry(script, "bootstrap");
});

test("uninstall.sh invokes the pinned uninstaller and forwards all arguments", () => {
  const script = readScript("uninstall.sh");

  assert.match(script.text, /npx/, "uninstall.sh must invoke the uninstaller with npx");
  assert.match(script.text, /node@24\.19\.0/, "uninstall.sh must pin Node to 24.19.0");
  assert.match(script.text, /install\/uninstall\.mjs/, "uninstall.sh must reference install/uninstall.mjs");
  assert.match(script.text, /"\$@"/, "uninstall.sh must forward all arguments");
  assertResolvedInstallEntry(script, "uninstall");
});

test("both scripts contain no foreign absolute paths", () => {
  for (const name of scripts) {
    assert.doesNotMatch(readScript(name).text, /\/Users\/[^\s/]+\//, `${name} must not contain a hardcoded home path`);
  }
});

test("install.sh checks for npx and gives an actionable Node installation hint", () => {
  const script = readScript("install.sh");

  assert.match(script.text, /command\s+-v\s+npx/, "install.sh must check npx with command -v");
  assert.match(script.text, /Node|brew/, "install.sh must tell users how to install Node");
});
