/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    check results recorded against a commit sha
 * USER STORY: As a builder I want a deploy to take only a sha whose checks are all green.
 * ARCHITECTURE: Pure functions; negative twins: wrong sha, unfinished run, missing build gate, error.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REQUIRED_GATES, type GatesOutcome } from './gates.ts';
import { recordFromOutcome, recordVerdict, recordFor, upsertRecord, markSuperseded, verdictOfRecord, MAX_CHECK_RECORDS, type CheckRecord } from './check-record.ts';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const outcome = (skip?: string, over: Record<string, 'pass' | 'fail' | 'unavailable'> = {}): GatesOutcome => ({
  ok: true,
  report: { schema: 'os-gates/v1', template: 'nextjs-web', ok: true, gates: REQUIRED_GATES.filter((g) => g !== skip).map((id) => ({ id, status: over[id] ?? 'pass', detail: 'x' })) },
});
const rec = (o: GatesOutcome, sha = SHA) => recordFromOutcome({ sha, trigger: 'push', engine: 'sandbox-job', startedAt: 't0', finishedAt: 't1', outcome: o });

test('build is a required gate', () => {
  assert.ok((REQUIRED_GATES as readonly string[]).includes('build'));
});

test('all required gates green for the same sha is green', () => {
  assert.equal(recordVerdict(rec(outcome()), SHA).green, true);
});

test('NEGATIVE: a record for another sha never answers for this one', () => {
  const v = recordVerdict(rec(outcome(), OTHER), SHA);
  assert.equal(v.green, false);
  assert.match(v.reason, /not/);
});

test('NEGATIVE: a missing build gate blocks', () => {
  const v = recordVerdict(rec(outcome('build')), SHA);
  assert.equal(v.green, false);
  assert.match(v.reason, /build/);
});

test('NEGATIVE: a failed or unavailable check blocks', () => {
  assert.equal(recordVerdict(rec(outcome(undefined, { tests: 'fail' })), SHA).green, false);
  assert.equal(recordVerdict(rec(outcome(undefined, { policy: 'unavailable' })), SHA).green, false);
});

test('NEGATIVE: a sandbox that could not run, a running or a superseded record, and no record, block', () => {
  assert.equal(recordVerdict(rec({ ok: false, kind: 'no-cluster', reason: 'down' }), SHA).green, false);
  assert.equal(recordVerdict({ ...rec(outcome()), status: 'running' }, SHA).green, false);
  assert.equal(recordVerdict({ ...rec(outcome()), status: 'superseded' }, SHA).green, false);
  assert.equal(recordVerdict(null, SHA).green, false);
});

test('NEGATIVE: an extra failing check (the scan) blocks even when every gate passed', () => {
  const r = recordFromOutcome({ sha: SHA, trigger: 'button', engine: 'sandbox-job', startedAt: 't0', finishedAt: 't1', outcome: outcome(), extra: [{ id: 'scan', status: 'fail', detail: 'CVE-1 critical' }] });
  const v = recordVerdict(r, SHA);
  assert.equal(v.green, false);
  assert.match(v.reason, /scan/);
});

test('upsert keeps newest first, one record per sha, bounded', () => {
  let list = upsertRecord(undefined, rec(outcome()));
  list = upsertRecord(list, rec(outcome(), OTHER));
  list = upsertRecord(list, { ...rec(outcome(undefined, { tests: 'fail' })), trigger: 'button' });
  assert.deepEqual(list.map((r) => r.sha), [SHA, OTHER]);
  assert.equal(recordFor(list, SHA)!.trigger, 'button');
  for (let i = 0; i < MAX_CHECK_RECORDS + 5; i++) list = upsertRecord(list, rec(outcome(), String(i).padStart(40, '0')));
  assert.equal(list.length, MAX_CHECK_RECORDS);
});

// ---------------------------------------------------------------- supersede (Tekton CI) ---

const running = (sha: string): CheckRecord => ({ ...rec(outcome(), sha), status: 'running', finishedAt: null, checks: [] });

test('markSuperseded flips only RUNNING records of the named shas; finished results and other shas are untouched', () => {
  const list = [running(SHA), rec(outcome(), OTHER), running('c'.repeat(40))];
  const out = markSuperseded(list, [SHA, OTHER]);
  assert.equal(out.find((r) => r.sha === SHA)!.status, 'superseded');
  assert.ok(out.find((r) => r.sha === SHA)!.finishedAt, 'the moment it was superseded is recorded');
  assert.equal(out.find((r) => r.sha === OTHER)!.status, 'finished', 'a finished record is a fact and stays');
  assert.equal(out.find((r) => r.sha === 'c'.repeat(40))!.status, 'running');
  assert.equal(recordVerdict(out.find((r) => r.sha === SHA), SHA).green, false);
});

test('verdictOfRecord: the sentence and the blocking list a card or an MCP caller reads', () => {
  const ok = verdictOfRecord(rec(outcome()), SHA);
  assert.equal(ok.passed, true);
  const red = verdictOfRecord(rec(outcome(undefined, { tests: 'fail' })), SHA);
  assert.equal(red.passed, false);
  assert.ok(red.blocking.some((b) => b.id === 'tests'));
  const run = verdictOfRecord(running(SHA), SHA);
  assert.equal(run.passed, false);
  assert.match(run.summary, /running/);
  const none = verdictOfRecord(null, SHA);
  assert.equal(none.passed, false);
  assert.match(none.summary, /no check result/);
});
