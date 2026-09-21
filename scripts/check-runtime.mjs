import { assertSupportedRuntime } from "../src/runtime.mjs";

try {
  assertSupportedRuntime();
} catch (error) {
  process.stderr.write(`${error.message}. Use the version in .node-version or run npm run test:node24.\n`);
  process.exitCode = 1;
}
