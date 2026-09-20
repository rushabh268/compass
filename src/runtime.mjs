const supportedRuntime = "Node.js 24.19 or newer and below 25";

export function assertSupportedRuntime(version = process.versions.node) {
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`invalid Node.js version: ${String(version)}`);
  }

  const [major, minor] = version.split(".").map(Number);
  if (major !== 24 || minor < 19) {
    throw new Error(`unsupported Node.js version ${version}; requires ${supportedRuntime}`);
  }
}
