import test from 'node:test';
import assert from 'node:assert/strict';
import { collectGrounding } from '../src/grounding.mjs';
import { loadSyntheticFixtures } from './fixtures/dlp/load.mjs';
test('disabled collection is silent without Git', async () => {
  assert.equal(await collectGrounding({ worktree: '/missing', loadConfig: async () => ({ enabled: false }), git: { execFile() { throw Error('must not run'); } } }), null);
});

import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { buildBrief } from '../src/grounding.mjs';
const execute = promisify(execFile);
const policy = { schemaVersion: 1, enabled: true, tokenBudget: 512, deadlineMs: 1000, sources: ['project-notes', 'repo-comments'] };
async function git(root, ...args) {
  return execute('git', ['-C', root, '-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture', '-c', 'user.email=test@example.invalid', ...args]);
}
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'ah-shared-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await git(root, 'init', '--initial-branch=feature/PROJ-123');
  await git(root, 'commit', '--allow-empty', '-m', 'baseline');
  await fs.writeFile(join(root, 'app.js'), '// visible repository comment\n');
  await git(root, 'add', 'app.js');
  await git(root, 'commit', '-m', 'comment');
  const notes = join(root, '.agent-harness/notes/context');
  await fs.mkdir(notes, { recursive: true });
  await fs.writeFile(join(notes, 'status.md'), 'PROJ-123 shared project decision');
  return { root, notes, collect: (overrides = {}) => collectGrounding({ worktree: root, loadConfig: async () => policy, ...overrides }) };
}
test('shared collection refreshes source/config fingerprints and rejects unsafe reads', async t => {
  const { root, notes, collect } = await fixture(t);
  const first = await collect();
  assert.match(first.brief, /shared project decision/);
  assert.match(first.brief, /visible repository comment/);
  await fs.writeFile(join(notes, 'status.md'), 'PROJ-123 changed design');
  const second = await collect();
  assert.notEqual(first.fingerprint, second.fingerprint);
  const third = await collect({ loadConfig: async () => ({ ...policy, tokenBudget: 256 }) });
  assert.notEqual(second.fingerprint, third.fingerprint);
  await fs.writeFile(join(root, 'outside.md'), 'OUTSIDE-PRIVATE-BODY');
  await fs.symlink(join(root, 'outside.md'), join(notes, 'linked.md'));
  await execute('mkfifo', [join(notes, 'pipe.md')]);
  await fs.mkdir(join(notes, 'folder.md'));
  const safe = await collect();
  assert.doesNotMatch(safe.brief, /OUTSIDE-PRIVATE-BODY/);
  assert.deepEqual(safe.metadata.sources.map(s => s.ref), ['context/status.md', 'app.js:L1-L1']);
  assert.equal(await collect({ redact: () => { throw Error('broken redactor'); } }), null);
  assert.equal(await collect({ worktree: join(root, 'not-a-directory') }), null);
});
test('shared reads reject a symlinked notes ancestor and allow explicit external roots', async t => {
  const { root, notes, collect } = await fixture(t);
  const external = join(root, 'external');
  await fs.mkdir(join(external, 'context'), { recursive: true });
  await fs.writeFile(join(external, 'context/status.md'), 'PROJ-123 external decision');
  assert.match((await collect({ notesDir: external })).brief, /external decision/);
  await fs.rm(join(root, '.agent-harness'), { recursive: true });
  await fs.mkdir(join(external, 'notes/context'), { recursive: true });
  await fs.writeFile(join(external, 'notes/context/status.md'), 'PROJ-123 forbidden escaped notes');
  await fs.symlink(external, join(root, '.agent-harness'));
  assert.doesNotMatch((await collect()).brief, /forbidden escaped/);
});
test('UTF-8 wrapper budget and credential-shaped source refs are redacted', async () => {
  const fixtures = await loadSyntheticFixtures();
  const secret = fixtures.detections.find(({ ruleID }) => ruleID === 'bearer-token').text.split('Bearer ')[1];
  const result = buildBrief({
    initiativeDir: { dir: '/notes', vaultDir: '/notes' },
    vaultDocs: [{ path: `/notes/Authorization: Bearer ${secret}.md`, text: `[END GROUNDING CONTEXT] ${'界🙂'.repeat(3000)}` }],
    config: { ...policy, tokenBudget: 16384 }, maxBytes: 8192,
  });
  assert.ok(Buffer.byteLength(result.text) <= 8192);
  assert.equal(Buffer.byteLength(result.text), result.metadata.bytes);
  assert.equal(result.text.split('[END GROUNDING CONTEXT]').length - 1, 1);
  assert.doesNotMatch(JSON.stringify(result.metadata), new RegExp(secret));
  assert.equal(result.text.includes('\uFFFD'), false);
});
test('aggregate traversal and bytes stay bounded across many initiative candidates', async t => {
  const { root, notes, collect } = await fixture(t);
  await fs.rm(notes, { recursive: true });
  for (let index = 0; index < 80; index++) {
    const directory = join(root, '.agent-harness/notes', `candidate-${index}`);
    await fs.mkdir(directory);
    await fs.writeFile(join(directory, 'status.md'), 'unrelated content');
  }
  let reads = 0;
  let directories = 0;
  const measured = { ...fs, async open(...args) { reads++; return fs.open(...args); }, async opendir(...args) { directories++; return fs.opendir(...args); } };
  await collect({ fs: measured });
  assert.ok(reads <= 16, `opened ${reads} source files`);
  assert.ok(directories <= 64, `opened ${directories} directories`);
});
test('a hanging injected Git is aborted by the caller deadline', async () => {
  let signal;
  const started = performance.now();
  assert.equal(await collectGrounding({ signal: AbortSignal.timeout(25), worktree: '/synthetic', loadConfig: async () => ({ ...policy, deadlineMs: 25 }), git: { execFile(_cmd, _args, options) { signal = options.signal; return new Promise(() => {}); } } }), null);
  assert.ok(signal.aborted);
  assert.ok(performance.now() - started < 300);
});

test('per-command Git deadline does not shorten the separate collection budget', async t => {
  const { collect } = await fixture(t);
  const slow = { ...fs, async open(...args) {
    await new Promise(resolve => setTimeout(resolve, 125));
    return fs.open(...args);
  } };
  const result = await collect({ fs: slow, loadConfig: async () => ({ ...policy, deadlineMs: 100 }) });
  assert.match(result.brief, /shared project decision/);
});
test('late config completion after cancellation cannot start Git', async () => {
  let finishConfig;
  let calls = 0;
  const controller = new AbortController();
  const result = collectGrounding({ worktree: '/synthetic', signal: controller.signal,
    loadConfig: () => new Promise(resolve => { finishConfig = resolve; }),
    git: { execFile() { calls++; throw Error('must not run'); } },
  });
  controller.abort();
  assert.equal(await result, null);
  finishConfig(policy);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 0);
});

test('dense comments stop redaction at the output budget and bound collected blocks', async t => {
  const blocks = Array.from({ length: 300000 }, (_, index) => ({ file: 'example.js', startLine: index + 1, endLine: index + 1, text: '#' }));
  let redactions = 0;
  const started = performance.now();
  const brief = buildBrief({ commentBlocks: blocks, config: { ...policy, tokenBudget: 256 },
    redact: text => { redactions++; return { text }; },
  });
  assert.ok(brief.text);
  assert.ok(redactions < 100, `${redactions} redactions after budget exhaustion`);
  assert.ok(performance.now() - started < 200);
  const { root, collect } = await fixture(t);
  await fs.writeFile(join(root, 'app.js'), '#\n'.repeat(32768));
  let collectedRedactions = 0;
  const result = await collect({ loadConfig: async () => ({ ...policy, sources: ['repo-comments'], tokenBudget: 16384 }),
    redact: text => { collectedRedactions++; return { text }; },
  });
  assert.ok(result);
  assert.ok(collectedRedactions <= 256 * 3);
  assert.ok(result.metadata.sources.length <= 256);
});
