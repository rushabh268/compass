import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { collectGrounding } from '../src/grounding.mjs';
import { buildGroundingEvent } from '../src/grounding-event.mjs';
import { openLedger } from '../src/state/ledger.mjs';
import { startSupervisor } from '../src/supervisor/server.mjs';
const execute = promisify(execFile);
const hook = new URL('../src/grounding-hook.mjs', import.meta.url).pathname;
const policy = { schemaVersion: 1, enabled: true, tokenBudget: 256, deadlineMs: 1000, sources: ['project-notes'] };
const key = Buffer.alloc(32, 0x72);
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'ah-native-ground-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  await fs.mkdir(repo);
  await execute('git', ['-C', repo, 'init', '--initial-branch=feature/PROJ-123']);
  await execute('git', ['-C', repo, '-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'baseline']);
  const notes = join(repo, '.agent-harness/notes/context');
  await fs.mkdir(notes, { recursive: true });
  await fs.writeFile(join(notes, 'status.md'), 'PROJ-123 NATIVE-SOURCE-PRIVATE-BODY\nAuthorization: Bearer b7Qx_2mN9-vR4.kL8sP0\n');
  const config = join(root, 'grounding.json');
  const keyFile = join(root, 'auth.key');
  await fs.writeFile(config, JSON.stringify(policy));
  await fs.writeFile(keyFile, key, { mode: 0o600 });
  return { root, repo, notes, config, env: { AGENT_HARNESS_GROUNDING_CONFIG: config, AGENT_HARNESS_STATE_DIR: root, AGENT_HARNESS_KEY_FILE: keyFile, AGENT_HARNESS_SOCKET: join(root, 'missing.sock'), AGENT_HARNESS_NOTES_DIR: '' } };
}
function run(platform, payload, env, { holdInput = false } = {}) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(process.execPath, [hook, '--platform', platform], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.on('error', () => {});
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ stdout, stderr, code, signal, elapsed: performance.now() - started }));
    if (!holdInput) child.stdin.end(typeof payload === 'object' && !Buffer.isBuffer(payload) ? JSON.stringify(payload) : payload);
  });
}
function clean(result) {
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
}
test('both native platforms emit only documented envelopes for all context events and refresh edits', async t => {
  const f = await fixture(t);
  const shared = await collectGrounding({ worktree: f.repo, loadConfig: async () => policy });
  for (const platform of ['claude', 'codex']) {
    for (const event of ['SessionStart', 'UserPromptSubmit', 'SubagentStart']) {
      const result = await run(platform, { cwd: f.repo, hook_event_name: event, prompt: 'PROMPT-PRIVATE-SENTINEL', transcript_path: '/never-read-transcript' }, f.env);
      clean(result);
      assert.deepEqual(JSON.parse(result.stdout), { hookSpecificOutput: { hookEventName: event, additionalContext: shared.brief } });
      assert.doesNotMatch(result.stdout, /b7Qx_2mN9-vR4|PROMPT-PRIVATE-SENTINEL/);
    }
  }
  await fs.writeFile(join(f.notes, 'status.md'), 'PROJ-123 revised decision');
  assert.match((await run('codex', { cwd: f.repo, hook_event_name: 'UserPromptSubmit' }, f.env)).stdout, /revised decision/);
  await fs.writeFile(f.config, JSON.stringify({ ...policy, enabled: false }));
  assert.equal((await run('claude', { cwd: f.repo, hook_event_name: 'SessionStart' }, f.env)).stdout, '');
});
test('malformed unsupported oversized and invalid cwd callbacks are silent', async t => {
  const f = await fixture(t);
  const payload = { cwd: f.repo, hook_event_name: 'SessionStart' };
  for (const [platform, value] of [
    ['claude', '{'], ['codex', Buffer.from([0xc3, 0x28])], ['claude', 'x'.repeat(1024 * 1024 + 1)],
    ['other', payload], ['claude', { ...payload, hook_event_name: 'PostToolUse' }],
    ['codex', { ...payload, cwd: '.' }], ['claude', { hook_event_name: 'SessionStart' }],
    ['codex', { ...payload, cwd: f.root }],
  ]) { const result = await run(platform, value, f.env); clean(result); assert.equal(result.stdout, ''); }
  await fs.writeFile(f.config, '{');
  assert.equal((await run('claude', payload, f.env)).stdout, '');
});
test('native whole-process deadline covers hung stdin and Git', async t => {
  const f = await fixture(t);
  const stdin = await run('claude', '', f.env, { holdInput: true });
  clean(stdin); assert.equal(stdin.stdout, ''); assert.ok(stdin.elapsed < 1300, `stdin ${stdin.elapsed}ms`);
  const bin = join(f.root, 'bin');
  await fs.mkdir(bin);
  await fs.writeFile(join(bin, 'git'), '#!/bin/sh\nexec /bin/sleep 20\n', { mode: 0o755 });
  const result = await run('codex', { cwd: f.repo, hook_event_name: 'SessionStart' }, { ...f.env, PATH: `${bin}:${process.env.PATH}` });
  clean(result); assert.equal(result.stdout, ''); assert.ok(result.elapsed < 1300, `git ${result.elapsed}ms`);
});
test('native Unicode content obeys complete wrapper hard cap and smaller configured budgets', async t => {
  const f = await fixture(t);
  await fs.writeFile(join(f.notes, 'status.md'), 'PROJ-123 ' + '界🙂'.repeat(6000));
  for (const tokenBudget of [16384, 256]) {
    await fs.writeFile(f.config, JSON.stringify({ ...policy, tokenBudget }));
    const result = await run('codex', { cwd: f.repo, hook_event_name: 'SessionStart' }, f.env);
    clean(result);
    const brief = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    assert.ok(Buffer.byteLength(brief) <= Math.min(8192, tokenBudget * 4));
    assert.ok(brief.endsWith('[END GROUNDING CONTEXT]'));
    assert.equal(brief.includes('\uFFFD'), false);
  }
});
test('missing key and stalled audit cannot suppress completed context or hold the process', async t => {
  const f = await fixture(t);
  const payload = { cwd: f.repo, hook_event_name: 'SessionStart' };
  const missing = await run('claude', payload, { ...f.env, AGENT_HARNESS_KEY_FILE: join(f.root, 'absent.key') });
  clean(missing); assert.match(missing.stdout, /NATIVE-SOURCE-PRIVATE-BODY/);
  const sockets = new Set();
  const server = net.createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.resume(); });
  const socketPath = join(f.root, 'stalled.sock');
  await new Promise(resolve => server.listen(socketPath, resolve));
  t.after(() => new Promise(resolve => { for (const socket of sockets) socket.destroy(); server.close(resolve); }));
  const stalled = await run('codex', payload, { ...f.env, AGENT_HARNESS_SOCKET: socketPath });
  clean(stalled); assert.match(stalled.stdout, /NATIVE-SOURCE-PRIVATE-BODY/);
  assert.ok(stalled.elapsed < 700, `audit ${stalled.elapsed}ms`);
});
test('native delivery audits persist only metadata, count all platforms, and dedupe immutable retries', async t => {
  const f = await fixture(t);
  const path = join(f.root, 'ledger/events.sqlite');
  const ledger = openLedger({ path, hmacKey: key });
  const socketPath = join(f.root, 'private/supervisor.sock');
  const supervisor = await startSupervisor({ socketPath, authKey: key, ledger });
  t.after(async () => { await supervisor.close(); ledger.close(); });
  for (const platform of ['claude', 'codex']) {
    for (const hook_event_name of ['SessionStart', 'UserPromptSubmit', 'SubagentStart']) {
      const result = await run(platform, { cwd: f.repo, hook_event_name, prompt: 'PROMPT-PRIVATE-SENTINEL' }, { ...f.env, AGENT_HARNESS_SOCKET: socketPath });
      clean(result); assert.match(result.stdout, /NATIVE-SOURCE-PRIVATE-BODY/);
    }
  }
  const shared = await collectGrounding({ worktree: f.repo, loadConfig: async () => policy });
  const event = buildGroundingEvent(shared.metadata, { platform: 'opencode', hmacKey: key, occurrenceID: 'stable-retry' });
  ledger.ensureRun(event.runID);
  ledger.append(event); ledger.append(event);
  assert.deepEqual(ledger.metrics().platforms, { claude: 3, codex: 3, opencode: 1 });
  assert.equal(ledger.metrics().grounding.injections, 7);
  for (const filename of [path, path + '-wal']) {
    const bytes = await fs.readFile(filename);
    for (const sentinel of ['NATIVE-SOURCE-PRIVATE-BODY', 'PROMPT-PRIVATE-SENTINEL', 'b7Qx_2mN9-vR4.kL8sP0', f.repo]) assert.equal(bytes.includes(Buffer.from(sentinel)), false);
  }
  const ignored = await run('codex', { cwd: f.repo, hook_event_name: 'PostToolUse' }, { ...f.env, AGENT_HARNESS_SOCKET: socketPath });
  assert.equal(ignored.stdout, '');
  assert.equal(ledger.metrics().grounding.injections, 7);
});

test('native linked and nested worktrees resolve notes from the main checkout', async t => {
  const f = await fixture(t);
  const linked = join(f.root, 'linked');
  const nested = join(f.repo, '.worktrees/nested');
  for (const [index, target] of [linked, nested].entries()) {
    await execute('git', ['-C', f.repo, 'worktree', 'add', '-b', `feature/PROJ-123-${index}`, target]);
    for (const platform of ['claude', 'codex']) {
      const result = await run(platform, { cwd: target, hook_event_name: 'SessionStart' }, f.env);
      clean(result);
      assert.match(result.stdout, /NATIVE-SOURCE-PRIVATE-BODY/);
    }
  }
});
