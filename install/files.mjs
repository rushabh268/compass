import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, parse, resolve, sep } from "node:path";

import { assertAbsolutePath } from "./plan.mjs";

const MAX_CONFIG_BYTES = 4 * 1024 * 1024;

async function canonicalPath(path) {
  assertAbsolutePath(path);
  let absolute = resolve(path);
  // These aliases are supplied by macOS, not by the user's configuration.
  if (process.platform === "darwin") {
    for (const prefix of ["/var", "/tmp", "/etc"]) {
      if (absolute === prefix || absolute.startsWith(`${prefix}/`)) {
        absolute = join(await realpath(prefix), absolute.slice(prefix.length));
        break;
      }
    }
  }
  return absolute;
}

export async function inspectPath(path, { directory = false, socket = false, mode } = {}) {
  const absolute = await canonicalPath(path);
  const root = parse(absolute).root;
  const parts = absolute.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]);
    let entry;
    try {
      entry = await lstat(current);
    } catch (error) {
      if (error.code === "ENOENT") return { path: absolute, entry: null };
      throw error;
    }
    if (entry.isSymbolicLink()) throw new Error(`installer path contains a symlink: ${current}`);
    if (index < parts.length - 1) {
      if (!entry.isDirectory()) throw new Error(`installer parent is not a directory: ${current}`);
      continue;
    }
    const validType = directory ? entry.isDirectory() : socket ? entry.isSocket() : entry.isFile();
    if (!validType) throw new Error(`unexpected installer path type: ${current}`);
    if (entry.uid !== process.getuid()) throw new Error(`installer path must be owned by the current user: ${current}`);
    if (entry.isFile() && entry.nlink !== 1) throw new Error(`installer file must not have multiple hard links: ${current}`);
    if (mode !== undefined && (entry.mode & 0o777) !== mode) {
      throw new Error(`installer path must have mode 0${mode.toString(8)}: ${current}`);
    }
    return { path: absolute, entry };
  }
  throw new Error("an installer artifact cannot be the filesystem root");
}

async function writableParent(path) {
  let parent = dirname(path);
  for (;;) {
    try {
      const entry = await lstat(parent);
      if (!entry.isDirectory()) throw new Error(`installer parent must be a directory: ${parent}`);
      if (entry.uid === process.getuid() && (entry.mode & 0o200) === 0) throw new Error(`installer parent is not writable: ${parent}`);
      await access(parent, constants.W_OK);
      return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      parent = dirname(parent);
    }
  }
}

export async function preflightFile(path, { writable = false, mode } = {}) {
  const result = await inspectPath(path, { mode });
  if (writable) {
    if (result.entry && (result.entry.mode & 0o200) === 0) throw new Error(`installer file is not writable: ${path}`);
    await writableParent(result.path);
  }
  return result;
}

export async function preflightDirectory(path, { mode } = {}) {
  const result = await inspectPath(path, { directory: true, mode });
  if (result.entry) {
    if ((result.entry.mode & 0o200) === 0) throw new Error(`installer directory is not writable: ${path}`);
    await access(result.path, constants.W_OK);
  } else await writableParent(result.path);
  return result;
}

export async function ensureDirectory(path, { mode = 0o700, exactMode = false } = {}) {
  const before = await preflightDirectory(path, { mode: exactMode ? mode : undefined });
  if (!before.entry) await mkdir(before.path, { recursive: true, mode });
  await inspectPath(path, { directory: true, mode: exactMode ? mode : undefined });
  return !before.entry;
}

export async function fileText(path, { maxBytes = MAX_CONFIG_BYTES, mode } = {}) {
  const before = await inspectPath(path, { mode });
  if (!before.entry) return null;
  const handle = await open(before.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const entry = await handle.stat();
    if (!entry.isFile() || entry.uid !== process.getuid() || entry.ino !== before.entry.ino || entry.dev !== before.entry.dev || entry.nlink !== 1 ||
        (mode !== undefined && (entry.mode & 0o777) !== mode)) throw new Error(`installer file changed while opening: ${path}`);
    if (entry.size > maxBytes) throw new Error(`installer configuration exceeds ${maxBytes} bytes: ${path}`);
    const bytes = await handle.readFile();
    if (bytes.length > maxBytes) throw new Error(`installer configuration exceeds ${maxBytes} bytes: ${path}`);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally {
    await handle.close();
  }
}

export async function writeIfDifferent(path, content, mode, expected) {
  const current = await fileText(path);
  if (expected !== undefined && current !== expected) throw new Error(`installer file changed after preflight: ${path}`);
  const checked = await preflightFile(path, { writable: true });
  if (current === content && (checked.entry.mode & 0o777) === mode) return false;
  await ensureDirectory(dirname(checked.path));
  const temporary = join(dirname(checked.path), `.agent-harness-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    try {
      await handle.writeFile(content);
      await handle.chmod(mode);
    } finally {
      await handle.close();
    }
    if (await fileText(path) !== current) throw new Error(`installer file changed while writing: ${path}`);
    await preflightFile(path, { writable: true });
    await rename(temporary, checked.path);
  } finally {
    await rm(temporary, { force: true });
  }
  return true;
}

export async function createIfAbsent(path, content, mode = 0o600) {
  const checked = await preflightFile(path);
  if (checked.entry) return false;
  await ensureDirectory(dirname(checked.path));
  let handle;
  try {
    handle = await open(checked.path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    await handle.writeFile(content);
    await handle.chmod(mode);
    return true;
  } catch (error) {
    if (error.code === "EEXIST") {
      await inspectPath(path);
      return false;
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

export function backupPaths(path) {
  return [`${path}.agent-harness.bak`, `${path}.bak`];
}

export async function preflightEdit({ path, original, changed }) {
  await preflightFile(path, { writable: changed });
  if (!changed || original === null) return;
  for (const backup of backupPaths(path)) await preflightFile(backup, { writable: true, mode: 0o600 });
}

export async function backupBeforeEdit({ path, original, changed }) {
  if (!changed || original === null) return;
  for (const backup of backupPaths(path)) await createIfAbsent(backup, original);
}

export async function removeFile(path, expected) {
  const checked = await preflightFile(path, { writable: true });
  if (!checked.entry) return;
  if (expected !== undefined && await fileText(path) !== expected) throw new Error(`installer file changed after preflight: ${path}`);
  await rm(checked.path);
}
