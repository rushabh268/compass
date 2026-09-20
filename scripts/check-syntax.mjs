import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function enumerateJavaScriptFiles(roots) {
  const files = [];

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && (entry.name.endsWith(".mjs") || entry.name.endsWith(".js"))) files.push(path);
    }
  }

  for (const root of roots) await visit(resolve(root));
  return files;
}

function checkFile(path) {
  return new Promise((resolveCheck) => {
    const child = spawn(process.execPath, ["--check", path], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolveCheck({ path, error }));
    child.on("close", (code) => resolveCheck(code === 0 ? null : { path, error: new Error(stderr.trim()) }));
  });
}

export async function checkSyntax(roots) {
  const files = await enumerateJavaScriptFiles(roots);
  const failures = (await Promise.all(files.map(checkFile))).filter(Boolean);
  if (failures.length > 0) {
    throw new Error(failures.map(({ path, error }) => `${path}: ${error.message}`).join("\n"));
  }
  return files;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  checkSyntax(["src", "adapters", "install", "scripts"].map((directory) => join(repositoryRoot, directory))).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
