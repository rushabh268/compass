import { chmod, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import net from "node:net";
import { dirname, join, parse, resolve, sep } from "node:path";

async function rejectSymlinkComponents(path, includeLeaf) {
  let absolute = resolve(path);
  if (process.platform === "darwin" && (absolute === "/var" || absolute.startsWith("/var/"))) {
    absolute = join(await realpath("/var"), absolute.slice(5));
  }
  const parsed = parse(absolute);
  const parts = absolute.slice(parsed.root.length).split(sep).filter(Boolean);
  let current = parsed.root;
  const count = includeLeaf ? parts.length : parts.length - 1;
  for (let index = 0; index < count; index += 1) {
    current = join(current, parts[index]);
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink()) throw new Error(`path contains symlink: ${current}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return absolute;
}

export async function prepareSocketPath(path) {
  if (typeof path !== "string" || path.length === 0) throw new TypeError("socketPath must be a nonempty string");
  const socketPath = await rejectSymlinkComponents(path, true);
  const parent = dirname(socketPath);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentStat = await lstat(parent);
  if (!parentStat.isDirectory() || parentStat.uid !== process.getuid() || (parentStat.mode & 0o777) !== 0o700) {
    throw new Error("socket parent must be owned by the current uid and mode 0700");
  }
  try {
    const entry = await lstat(socketPath);
    if (entry.isSymbolicLink()) throw new Error("socket path must not be a symlink");
    if (!entry.isSocket() || entry.uid !== process.getuid()) throw new Error("socket path already exists and is not an owned socket");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return socketPath;
}

export async function removeStaleSocket(path) {
  let entry;
  try {
    entry = await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  await new Promise((resolve, reject) => {
    const socket = net.createConnection(path);
    socket.once("connect", () => {
      socket.destroy();
      reject(new Error("socket is already active"));
    });
    socket.once("error", (error) => {
      socket.destroy();
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve();
      else reject(error);
    });
  });
  let current;
  try {
    current = await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (!current.isSocket() || current.uid !== process.getuid() || current.dev !== entry.dev || current.ino !== entry.ino) {
    throw new Error("socket path changed while probing");
  }
  await unlink(path);
}

export async function readAuthKeyFile(path) {
  if (typeof path !== "string" || path.length === 0) throw new TypeError("key file path is required");
  const keyPath = await rejectSymlinkComponents(path, true);
  let handle;
  try {
    const entry = await lstat(keyPath);
    if (entry.isSymbolicLink()) throw new Error("key file must not be a symlink");
    if (!entry.isFile() || entry.uid !== process.getuid() || (entry.mode & 0o777) !== 0o600) {
      throw new Error("key file must be owned by the current uid and mode 0600");
    }
    handle = await open(keyPath, "r");
    const opened = await handle.stat();
    const resolved = await realpath(keyPath);
    if (resolved !== keyPath || opened.dev !== entry.dev || opened.ino !== entry.ino || !opened.isFile() ||
        opened.uid !== process.getuid() || (opened.mode & 0o777) !== 0o600) {
      throw new Error("key file changed while opening");
    }
    const key = await handle.readFile();
    if (key.length < 32) throw new Error("key file must contain at least 32 bytes");
    return key;
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("key file does not exist");
    throw error;
  } finally {
    await handle?.close();
  }
}

export async function setSocketMode(path) {
  await chmod(path, 0o600);
}
