/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    Tests for the builder's prompts and its tolerant reply parsers
 * USER STORY: As the engineer who knows a reasoning model wraps JSON in prose I want the coder's
 *             reply recovered tolerantly, its paths refused strictly, and an unparseable reviewer
 *             to loop rather than ship.
 * ARCHITECTURE: Pure unit tests over `prompts.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveAcceptanceChecks } from './acceptance.ts';
import { coderPrompt, parseCoderReply, parseReviewReply, pathRefusal, plannerPrompt, reviewerPrompt } from './prompts.ts';
import type { GroundingStory } from './grounding.ts';

const story: GroundingStory = { epicId: 'e1', storyId: 's1', title: 'See every open invoice', features: [], nfrs: [], rules: [] };
const checks = deriveAcceptanceChecks([story]);

test('the planner is told to plan, not to code, and is given the checks', () => {
  const p = plannerPrompt('(pack)', checks);
  assert.ok(p.system.includes('You are the PLANNER'));
  assert.ok(p.system.includes('Do NOT write code'));
  assert.ok(p.user.includes('ACCEPTANCE CHECKS your plan must satisfy:'));
  assert.ok(p.user.includes('e1/s1'));
});

test('the coder is told the JSON shape, and the FEEDBACK rides in verbatim on a retry', () => {
  const first = coderPrompt({ grounding: '(pack)', plan: '1. a page', checks, prior: [], feedback: null });
  assert.ok(first.system.includes('"files"'));
  assert.ok(first.system.includes('Never a placeholder'));
  assert.ok(!first.user.includes('REJECTED'));
  const retry = coderPrompt({
    grounding: '(pack)',
    plan: '1. a page',
    checks,
    prior: [{ path: 'src/App.tsx', content: 'x' }],
    feedback: 'src/App.tsx:3:1 TS2304: Cannot find name Card',
  });
  assert.ok(retry.user.includes('YOUR PREVIOUS ATTEMPT WAS REJECTED'));
  assert.ok(retry.user.includes('TS2304: Cannot find name Card'), 'the diagnostics must reach the model unchanged');
  assert.ok(retry.user.includes('FILES ALREADY COMMITTED'));
});

test('the reviewer is told PASS means every machine-decidable check passed', () => {
  const p = reviewerPrompt({ report: 'Acceptance: 1 passed', compileText: 'compile check passed' });
  assert.ok(p.system.includes('Never pass a scorecard with a FAIL or an UNKNOWN'));
  assert.ok(p.system.includes('MANUAL is for a human'));
  assert.ok(p.user.includes('Acceptance: 1 passed'));
});

test('parseCoderReply recovers JSON wrapped in prose (the known reasoning-model landmine)', () => {
  const raw = 'Sure! Here is the app:\n```json\n{ "files": [ { "path": "src/App.tsx", "content": "export const A = 1;" } ] }\n```\nHope that helps.';
  const parsed = parseCoderReply(raw);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.files, [{ path: 'src/App.tsx', content: 'export const A = 1;' }]);
  assert.deepEqual(parsed.refused, []);
});

test('path discipline is ENFORCED, not hoped for', () => {
  assert.equal(pathRefusal('src/App.tsx'), null);
  assert.equal(pathRefusal('public/logo.svg'), null);
  assert.equal(pathRefusal('index.html'), null);
  assert.equal(pathRefusal('package.json'), null);
  assert.ok(pathRefusal('/etc/passwd')?.includes('absolute'));
  assert.ok(pathRefusal('src/../../secret')?.includes('escapes'));
  assert.ok(pathRefusal('vendor/@sovereign-os/ui/Card.tsx')?.includes('vendored tree'));
  assert.ok(pathRefusal('node_modules/x/index.js')?.includes('vendored tree'));
  assert.ok(pathRefusal('Dockerfile')?.includes('outside src/'));
  assert.ok(pathRefusal('')?.includes('empty'));
});

test('a refused path is DROPPED with a reason; the usable files still land', () => {
  const raw = JSON.stringify({
    files: [
      { path: 'src/Good.tsx', content: 'export const G = 1;' },
      { path: '../escape.ts', content: 'bad' },
      { path: 'src/Empty.tsx', content: '' },
    ],
  });
  const parsed = parseCoderReply(raw);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.files.map((f) => f.path), ['src/Good.tsx']);
  assert.equal(parsed.refused.length, 2);
  assert.ok(parsed.refused.some((r) => r.includes('escapes')));
  assert.ok(parsed.refused.some((r) => r.includes('must be complete')));
});

test('an unusable coder reply is a typed failure, never an empty "success"', () => {
  for (const raw of ['I cannot do that.', '{ "tabs": [] }', '{ "files": [] }', '{ "files": [{ "path": "/x", "content": "y" }] }']) {
    const parsed = parseCoderReply(raw);
    assert.equal(parsed.ok, false, raw);
    assert.ok(!parsed.ok && parsed.reason.length > 0);
  }
});

test('a duplicate path keeps the LAST copy only', () => {
  const parsed = parseCoderReply(
    JSON.stringify({ files: [{ path: 'src/A.tsx', content: 'first' }, { path: 'src/A.tsx', content: 'second' }] }),
  );
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.files, [{ path: 'src/A.tsx', content: 'second' }]);
  assert.ok(parsed.refused[0].includes('appeared twice'));
});

test('parseReviewReply FAILS SAFE: anything but an explicit PASS loops', () => {
  assert.equal(parseReviewReply('VERDICT: PASS\nNOTES:').verdict, 'pass');
  assert.equal(parseReviewReply('verdict: pass').verdict, 'pass');
  assert.equal(parseReviewReply('VERDICT: REVISE\nNOTES:\n- wire the table').verdict, 'revise');
  assert.equal(parseReviewReply('I think it looks great, ship it!').verdict, 'revise');
  assert.equal(parseReviewReply('').verdict, 'revise');
  assert.deepEqual(parseReviewReply('VERDICT: REVISE\n- one\n* two').notes, ['one', 'two']);
});
