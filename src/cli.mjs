#!/usr/bin/env node
import { assertSupportedRuntime } from "./runtime.mjs";

assertSupportedRuntime();

function options(args, allowed, booleanFlags = new Set()) {
  const parsed = {};
  let index = 0;
  while (index < args.length) {
    const name = args[index];
    if (!name?.startsWith("--")) throw new Error("invalid command options");
    if (!allowed.has(name)) throw new Error(`unknown option: ${name}`);
    if (Object.hasOwn(parsed, name)) throw new Error(`duplicate option: ${name}`);
    if (booleanFlags.has(name)) {
      parsed[name] = true;
      index += 1;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`missing value for option: ${name}`);
    parsed[name] = value;
    index += 2;
  }
  return parsed;
}

function parseBoundedInteger(value, name, { min, max } = {}) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error(`${name} must be a nonnegative integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be a safe integer`);
  if (min !== undefined && parsed < min) throw new Error(`${name} must be >= ${min}`);
  if (max !== undefined && parsed > max) throw new Error(`${name} must be <= ${max}`);
  return parsed;
}

async function main() {
  const [{ openLedger }, { readAuthKeyFile }, { request }, { startSupervisor }, { runCanary }, { startDashboard }] = await Promise.all([
    import("./state/ledger.mjs"),
    import("./paths.mjs"),
    import("./supervisor/client.mjs"),
    import("./supervisor/server.mjs"),
    import("./canary.mjs"),
    import("./dashboard.mjs"),
  ]);
  const [command, ...args] = process.argv.slice(2);
  const allowed = command === "serve" || command === "canary"
    ? new Set(["--socket", "--key-file", "--ledger"])
    : command === "health" || command === "status" || command === "verify" || command === "retention-status" ? new Set(["--socket", "--key-file"])
    : command === "prune" ? new Set(["--socket", "--key-file", "--dry-run", "--older-than-unix", "--max-runs"])
    : command === "dashboard" ? new Set(["--socket", "--key-file", "--port", "--refresh-seconds"])
    : new Set();
  if (!allowed.size) throw new Error(`unknown command: ${command ?? ""}`);
  const booleanFlags = command === "prune" ? new Set(["--dry-run"]) : new Set();
  const flags = options(args, allowed, booleanFlags);
  if (!flags["--socket"] || !flags["--key-file"]) throw new Error("--socket and --key-file are required");
  if ((command === "serve" || command === "canary") && !flags["--ledger"]) throw new Error(`${command} requires --ledger`);
  let pruneParams;
  if (command === "prune") {
    if (!flags["--dry-run"]) throw new Error("--dry-run is required");
    if (flags["--older-than-unix"] === undefined) throw new Error("--older-than-unix is required");
    if (flags["--max-runs"] === undefined) throw new Error("--max-runs is required");
    pruneParams = {
      olderThanUnix: parseBoundedInteger(flags["--older-than-unix"], "--older-than-unix", { min: 0 }),
      maxRuns: parseBoundedInteger(flags["--max-runs"], "--max-runs", { min: 1, max: 1_000 }),
      dryRun: true,
    };
  }
  let dashboardParams;
  if (command === "dashboard") {
    dashboardParams = {
      port: flags["--port"] !== undefined ? parseBoundedInteger(flags["--port"], "--port", { min: 0, max: 65535 }) : 7071,
      refreshSeconds: flags["--refresh-seconds"] !== undefined ? parseBoundedInteger(flags["--refresh-seconds"], "--refresh-seconds", { min: 1, max: 300 }) : 10,
    };
  }
  const authKey = await readAuthKeyFile(flags["--key-file"]);
  try {
    if (command === "health") {
      const result = await request({ socketPath: flags["--socket"], authKey, method: "health", params: {} });
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }
    if (command === "status" || command === "verify") {
      const result = await request({
        socketPath: flags["--socket"],
        authKey,
        method: command === "status" ? "status" : "verifyAll",
        params: {},
      });
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }
    if (command === "retention-status") {
      const result = await request({ socketPath: flags["--socket"], authKey, method: "retentionStatus", params: {} });
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }
    if (command === "prune") {
      const result = await request({ socketPath: flags["--socket"], authKey, method: "prune", params: pruneParams });
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }
    if (command === "canary") {
      const result = await runCanary({ socketPath: flags["--socket"], authKey, ledgerPath: flags["--ledger"] });
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }
    if (command === "dashboard") {
      const dashboard = await startDashboard({ socketPath: flags["--socket"], authKey, ...dashboardParams });
      process.stdout.write(`${JSON.stringify({ url: dashboard.url })}\n`);
      const shutdown = async () => {
        process.removeAllListeners("SIGINT");
        process.removeAllListeners("SIGTERM");
        await dashboard.close();
      };
      process.once("SIGINT", () => { shutdown().then(() => process.exit(0), () => process.exit(1)); });
      process.once("SIGTERM", () => { shutdown().then(() => process.exit(0), () => process.exit(1)); });
      return;
    }
    const ledger = openLedger({ path: flags["--ledger"], hmacKey: authKey });
    let supervisor;
    try {
      supervisor = await startSupervisor({ socketPath: flags["--socket"], authKey, ledger });
    } catch (error) {
      ledger.close();
      throw error;
    }
    const shutdown = async () => {
      process.removeAllListeners("SIGINT");
      process.removeAllListeners("SIGTERM");
      try { await supervisor.close(); } finally { ledger.close(); }
    };
    process.once("SIGINT", () => { shutdown().then(() => process.exit(0), () => process.exit(1)); });
    process.once("SIGTERM", () => { shutdown().then(() => process.exit(0), () => process.exit(1)); });
  } finally {
    authKey.fill(0);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
