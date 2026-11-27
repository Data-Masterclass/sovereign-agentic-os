/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder B - story lights and status from per-criterion results; which story a commit names
 * USER STORY: As a business user I want a story's light to be green only when every criterion is proven by a passing
 *             tagged test, and a push without a story reference to be flagged.
 * ARCHITECTURE: Pure tables over lights.ts and story-ref.ts (no store, no model). Negative twins: truncated result,
 *             failing test, missing result, malformed result, a draft story with green tests, refs in docs-only pushes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AppRelease, CriteriaResults, StoryDoc } from '@tabs/software/lib/app-builder-contracts';
import type { CheckRecord } from '@tabs/software/lib/check-record';
import { devReleaseSha, evidenceRecord, lightsOfApp, parseCriteriaResult, recordIsGreen, storyLight, storyLights, storyStatus } from './lights.ts';
import { codePaths, isStoryless, revertedShas, storyRefNote, storyRefsInMessage, storyRefsInMessages } from './story-ref.ts';

const story = (id: string, n: number, state: 'draft' | 'agreed' = 'agreed'): StoryDoc => ({
  id: id as StoryDoc['id'],
  epic: 'EP-1',
  title: id,
  asA: 'a',
  iWant: 'b',
  soThat: 'c',
  state,
  notes: '',
  path: `stories/EP-1-x/${id}.md`,
  criteria: Array.from({ length: n }, (_, i) => ({ id: `AC-${i + 1}` as const, title: `c${i + 1}`, given: [], when: ['w'], then: ['t'] })),
});
const res = (r: Record<string, [number, number]>): CriteriaResults => ({ v: 1, results: Object.fromEntries(Object.entries(r).map(([k, [pass, fail]]) => [k, { pass, fail }])) as CriteriaResults['results'] });

test('lights table: green only when every criterion has a tagged test and none failed', () => {
  const s = story('US-3', 2);
  assert.equal(storyLight(s, res({ 'US-3/AC-1': [1, 0], 'US-3/AC-2': [2, 0] })).light, 'green');
  assert.deepEqual(storyLight(s, res({ 'US-3/AC-1': [1, 0] })), {
    light: 'partial',
    reason: 'uncovered',
    criteria: [
      { ref: 'US-3/AC-1', state: 'pass', pass: 1, fail: 0 },
      { ref: 'US-3/AC-2', state: 'untested', pass: 0, fail: 0 },
    ],
  });
  assert.equal(storyLight(s, res({ 'US-3/AC-1': [1, 1], 'US-3/AC-2': [1, 0] })).light, 'partial', 'any failing tagged test ⇒ partial');
  assert.equal(storyLight(s, res({ 'US-3/AC-1': [1, 1], 'US-3/AC-2': [1, 0] })).reason, 'failing');
  assert.equal(storyLight(s, res({ 'US-9/AC-1': [5, 0] })).light, 'untested', 'another story’s tests prove nothing here');
  assert.equal(storyLight(s, null).reason, 'no-result');
  assert.equal(storyLight(story('US-4', 0), res({})).reason, 'no-criteria');
});

test('lights table: a truncated result is partial with that reason, never green', () => {
  const t: CriteriaResults = { v: 1, truncated: true, results: {} };
  const d = storyLight(story('US-3', 1), t);
  assert.equal(d.light, 'partial');
  assert.equal(d.reason, 'truncated');
  assert.deepEqual(Object.values(storyLights({ stories: [story('US-1', 1), story('US-2', 2)] }, t)).map((x) => x.light), ['partial', 'partial']);
});

test('parseCriteriaResult: only a v1 result with integer counts and ref keys; anything else is no evidence', () => {
  assert.deepEqual(parseCriteriaResult('{"v":1,"results":{"US-3/AC-2":{"pass":1,"fail":0}}}'), { ok: true, result: res({ 'US-3/AC-2': [1, 0] }) });
  assert.deepEqual(parseCriteriaResult('{"v":1,"truncated":true}'), { ok: true, result: { v: 1, truncated: true, results: {} } });
  for (const bad of ['', 'nope', '{"v":2,"results":{}}', '{"v":1,"results":{"US-3":{"pass":1,"fail":0}}}', '{"v":1,"results":{"US-3/AC-1":{"pass":-1,"fail":0}}}', '{"v":1,"results":{"US-3/AC-1":{"pass":1.5,"fail":0}}}', '{"v":1,"results":[]}', null]) {
    const r = parseCriteriaResult(bad as string);
    assert.equal(r.ok, false, String(bad));
    assert.ok(!r.ok && r.reason.length > 0, 'the refusal says why');
  }
});

test('status: draft and agreed come from the file; built needs a green light AND a green run; verified needs it in Dev', () => {
  const g = { green: true, inDev: false };
  assert.equal(storyStatus({ state: 'draft' }, 'green', { green: true, inDev: true }), 'draft', 'a draft is never built');
  assert.equal(storyStatus({ state: 'agreed' }, 'partial', g), 'agreed', 'a refined criterion without a test falls back to agreed');
  assert.equal(storyStatus({ state: 'agreed' }, 'green', { green: false, inDev: true }), 'agreed', 'green tests in a red run are not built');
  assert.equal(storyStatus({ state: 'agreed' }, 'green', g), 'built');
  assert.equal(storyStatus({ state: 'agreed' }, 'green', { green: true, inDev: true }), 'verified');
});

const rec = (sha: string, status: CheckRecord['status'], criteria?: CriteriaResults, pass = true): CheckRecord => ({
  sha, status, trigger: 'push', engine: 'tekton', runRef: null, startedAt: 't', finishedAt: 't', error: null,
  checks: [{ id: 'tests', status: pass ? 'pass' : 'fail', detail: '' }], ...(criteria ? { criteria } : {}),
});
const sha = (c: string) => c.repeat(40);

test('evidence: the newest FINISHED record (or the head’s), green only when every check passed; Dev = newest running dev release', () => {
  const checks = [rec(sha('c'), 'running'), rec(sha('b'), 'finished', res({ 'US-1/AC-1': [1, 0] })), rec(sha('a'), 'finished')];
  assert.equal(evidenceRecord(checks)?.sha, sha('b'));
  assert.equal(evidenceRecord(checks, sha('a'))?.sha, sha('a'));
  assert.equal(evidenceRecord(checks, sha('c')), null, 'a running head has no evidence yet');
  assert.equal(recordIsGreen(rec(sha('a'), 'finished', undefined, false)), false);
  const rel = (s: string, at: string, extra: Partial<AppRelease> = {}): AppRelease => ({ id: at, slug: 'x', env: 'dev', sha: s, digest: 'sha256:1', at, by: 'u', previous: null, migrations: { applied: [], status: 'none' }, state: 'running', ...extra });
  assert.equal(devReleaseSha([rel(sha('a'), '1'), rel(sha('b'), '2'), rel(sha('c'), '3', { slot: 'p1' }), rel(sha('d'), '4', { state: 'failed' })]), sha('b'));
  const spec = { stories: [story('US-1', 1), story('US-2', 1, 'draft')] };
  const v = lightsOfApp(spec, { checks, releases: [rel(sha('b'), '1')] });
  assert.equal(v.sha, sha('b'));
  assert.equal(v.stories['US-1'].status, 'verified');
  assert.equal(v.stories['US-2'].status, 'draft');
  assert.equal(lightsOfApp(spec, { checks: [] }).stories['US-1'].light, 'untested');
});

test('story refs: the Story trailer and [US-n] / [US-n/AC-m] count; lookalikes do not', () => {
  assert.deepEqual(storyRefsInMessage('fix order intake\n\nStory: US-3, US-12'), ['US-3', 'US-12']);
  assert.deepEqual(storyRefsInMessage('add [US-4/AC-2] test and [US-7]'), ['US-4', 'US-7']);
  assert.deepEqual(storyRefsInMessage('story: us-3'), [], 'ids are case-sensitive');
  assert.deepEqual(storyRefsInMessage('US-3 without brackets and US-0'), []);
  assert.deepEqual(storyRefsInMessage('[US-0] [US-1234567]'), []);
  assert.deepEqual(storyRefsInMessages(['Story: US-2', 'x [US-1]']), ['US-1', 'US-2']);
  assert.equal(storyRefNote(['US-1', 'US-1', 'bad', 'US-2']), '[US-1] [US-2]');
  assert.deepEqual(revertedShas(`Revert "x"\n\nThis reverts commit ${sha('a')}.`), [sha('a')]);
});

test('storyless: code without a reference; stories, docs and top-level markdown are never code', () => {
  assert.equal(isStoryless(['apps/shop/src/app/page.tsx'], ['tweak']), true);
  assert.equal(isStoryless(['apps/shop/src/app/page.tsx'], ['tweak\n\nStory: US-1']), false);
  assert.equal(isStoryless(['apps/shop/stories/EP-1-x/US-1-y.md', 'apps/shop/docs/a.md', 'apps/shop/README.md'], ['docs']), false);
  assert.equal(isStoryless(['src/lib/x.ts', 'README.md'], []), true, 'app-relative paths too');
  assert.deepEqual(codePaths(['README.md', 'src/a.ts', 'docs/x/y.md', 'stories/EP-1-a/_epic.md', 'nested/notes.md']), ['src/a.ts', 'nested/notes.md']);
});
