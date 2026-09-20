import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGroundingEvent, utcMonth } from '../src/grounding-event.mjs';
const metadata = { sources: [{ kind: 'project-notes', ref: 'project/status.md' }], bytes: 300, approxTokens: 75, matchReason: 'none', commentFiles: 0, latencyMs: 1 };
const options = { hmacKey: Buffer.alloc(32, 7), now: '2026-09-30T23:59:59Z', occurrenceID: 'same' };
test('all platform grounding identities are separate, monthly, and immutable-retry safe', () => {
  const events = ['claude', 'codex', 'opencode'].map(platform => buildGroundingEvent(metadata, { ...options, platform }));
  for (const field of ['runID', 'eventID', 'dedupeKey', 'sessionHMAC']) assert.equal(new Set(events.map(event => event[field])).size, 3);
  const first = events[0];
  assert.deepEqual(first, buildGroundingEvent(metadata, { ...options, platform: 'claude' }));
  assert.notEqual(first.eventID, buildGroundingEvent(metadata, { ...options, platform: 'claude', occurrenceID: 'second' }).eventID);
  assert.notEqual(first.runID, buildGroundingEvent(metadata, { ...options, platform: 'claude', now: '2026-10-01T00:00:00Z' }).runID);
  assert.notEqual(buildGroundingEvent(metadata, { ...options, platform: 'claude', occurrenceID: undefined }).eventID,
    buildGroundingEvent(metadata, { ...options, platform: 'claude', occurrenceID: undefined }).eventID);
  assert.equal(utcMonth('2026-10-01T01:00:00+02:00'), '2026-09');
  assert.throws(() => buildGroundingEvent(metadata, options), /platform/);
  assert.throws(() => buildGroundingEvent({ ...metadata, brief: 'raw' }, { ...options, platform: 'codex' }));
});
