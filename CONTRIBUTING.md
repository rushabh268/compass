# Contributing

Compass is a local companion to a coding tool's native runtime. Changes
should preserve that boundary: adapters observe supported events; the native
tool still owns execution, permissions, context history, and its agent loop.
Grounding contributes bounded project context through each host’s supported
interface; it never returns control or approval decisions.

## Development

Use Node.js **24.19 or later within the 24.x line**, and macOS for the installer
tests. No runtime npm dependencies are required; development uses Ajv to check
the configuration schemas.

```sh
npm ci
npm test
npm run check
```

The test runner discovers nested test files. Do not substitute a shell glob
that silently excludes adapter tests. Tests use temporary keys, sockets,
ledgers, and homes; do not run the installer against your real home to test a
patch. Installer tests inject the command runner so they do not manage launchd.

For a behavior change, add a regression test that fails before the fix. Exercise
the real interface as well as translation: malformed input, unavailable and
stalled supervisors, payload limits, replay identity, and cleanup matter for
hooks. Changes to a platform or source enum must update its producers,
validators, installer defaults, fixtures, and documentation together.

Grounding changes must preserve the shared source-selection and redaction
contract across all three adapters. Test native output envelopes, the complete
UTF-8 brief budget, whole-process deadlines, safe bounded source reads, and
metadata-only audit. OpenCode’s request transform must stay free of source reads
and RPC calls. Do not rewrite native histories to imitate transient context.
See [the workflow](docs/grounding-workflow.md).

## Pull requests

Explain the concrete behavior before and after the change, then report the
checks you ran and any integration checks you could not run. Keep code and its
tests in the same focused change. Identify the client version or documented
hook contract on which a new integration depends.

Do not claim that a hook acknowledgment proves an independent review or that a
successful tool call proves a correct change. The ledger records observations;
the tests and review provide separate evidence.

## Sensitive data and fixtures

Use invented repositories, users, and domains such as `example.invalid`. Never
copy private repository notes, session exports, production credentials, or live
tool output into an issue or fixture. Credential-shaped fixtures must be
synthetic and labeled. Keep secret-scanner exceptions tied to individual
reviewed findings; do not exclude the entire test directory.

See [SECURITY.md](SECURITY.md) before reporting a vulnerability. Contributions
are distributed under the [MIT license](LICENSE).
