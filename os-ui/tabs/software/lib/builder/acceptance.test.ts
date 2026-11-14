/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    Tests for the story-derived acceptance checks
 * USER STORY: As the owner whose stories describe the app I want proof that the builder scores
 *             itself against THOSE stories and that it never claims a browser rendered anything.
 * ARCHITECTURE: Pure unit tests over `acceptance.ts` — derivation, the static scoring rules, the
 *               honesty of the evidence strings, and the corrective feedback text.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptanceFeedback,
  acceptanceSummary,
  deriveAcceptanceChecks,
  formatAcceptanceReport,
  impliesWrite,
  matchStoryFile,
  scoreAcceptanceChecks,
  titleTokens,
  type CompileOutcome,
} from './acceptance.ts';
import type { GroundingStory, SourceFile } from './grounding.ts';

const readStory: GroundingStory = {
  epicId: 'e1',
  storyId: 's1',
  title: 'See every open invoice',
  features: ['A table of open invoices'],
  nfrs: ['Loads in under two seconds'],
  rules: ['Only invoices of my own domain'],
};

const writeStory: GroundingStory = {
  epicId: 'e1',
  storyId: 's2',
  title: 'Submit a new expense claim',
  features: ['A form with amount and reason'],
  nfrs: [],
  rules: [],
};

const GREEN: CompileOutcome = { gated: true, ok: true, errors: [] };
const RED: CompileOutcome = { gated: true, ok: false, errors: ['src/App.tsx:3:1 TS2304: Cannot find name Card'] };
const UNGATED: CompileOutcome = { gated: false, ok: false, errors: [], note: 'legacy Next.js scaffold' };

test('H5 checks are DERIVED from the stories: one compile, route+render per story, manual per nfr/rule', () => {
  const checks = deriveAcceptanceChecks([readStory, writeStory]);
  assert.equal(checks.filter((c) => c.kind === 'compile').length, 1);
  assert.equal(checks.filter((c) => c.kind === 'route').length, 2);
  assert.equal(checks.filter((c) => c.kind === 'render').length, 2);
  // readStory has 1 nfr + 1 rule; writeStory has none.
  assert.equal(checks.filter((c) => c.kind === 'manual').length, 2);
  // Ids are stable and derivation-ordered, and every check names its story.
  assert.deepEqual(checks.slice(0, 3).map((c) => c.id), ['c1', 'c2', 'c3']);
  assert.equal(checks[0].story, '(the whole build)');
  assert.equal(checks[1].storyId, 's1');
  // A write story's render check asks for the WRITE surface, not a read.
  const writeRender = checks.find((c) => c.kind === 'render' && c.storyId === 's2');
  assert.ok(writeRender && writeRender.check.includes('os.records'));
});

test('impliesWrite reads the story, not the model: capture verbs mean a write surface', () => {
  assert.equal(impliesWrite(writeStory), true);
  assert.equal(impliesWrite(readStory), false);
  assert.equal(impliesWrite({ ...readStory, rules: ['the user may approve a line'] }), true);
});

test('titleTokens drops stop words and short words so a match cannot be accidental', () => {
  assert.deepEqual(titleTokens('See every open invoice'), ['every', 'open', 'invoice']);
  assert.deepEqual(titleTokens('The user wants to see all data'), ['wants']);
});

test('matchStoryFile prefers the story id over a title word', () => {
  const files: SourceFile[] = [
    { path: 'src/epics/e1/s1/Page.tsx', content: 'export const P = 1;' },
    { path: 'src/InvoiceList.tsx', content: 'export const L = 1;' },
  ];
  const m = matchStoryFile(readStory, files);
  assert.equal(m?.file.path, 'src/epics/e1/s1/Page.tsx');
  assert.ok(m?.why.includes('story id'));
  // Without the id-shaped path, a distinctive title token still matches.
  const m2 = matchStoryFile(readStory, [files[1]]);
  assert.equal(m2?.file.path, 'src/InvoiceList.tsx');
  assert.ok(m2?.why.includes('path token'));
});

test('H6 route/render are scored by STATIC checks and the evidence says so', () => {
  const stories = [readStory];
  const checks = deriveAcceptanceChecks(stories);
  const files: SourceFile[] = [
    {
      path: 'src/epics/e1/s1/Page.tsx',
      content: "import { createOsClient } from '@sovereign-os/app-sdk';\nconst os = createOsClient();\nawait os.datasets.query('ds_1');",
    },
  ];
  const scores = scoreAcceptanceChecks(checks, stories, files, GREEN);
  const byId = new Map(scores.map((s) => [s.id, s]));
  assert.equal(byId.get('c1')?.status, 'pass');
  assert.ok(byId.get('c1')?.evidence.includes('compile gate'));
  assert.equal(byId.get('c2')?.status, 'pass');
  assert.ok(byId.get('c2')?.evidence.startsWith('static check:'), 'a route pass must say it was static');
  assert.equal(byId.get('c3')?.status, 'pass');
  assert.ok(byId.get('c3')?.evidence.includes('calls os.datasets'));
  assert.ok(byId.get('c3')?.evidence.startsWith('static check (AST):'), 'a render pass must name the AST');
  // Every non-manual evidence string says HOW it was decided — never "rendered".
  for (const s of scores) assert.ok(!/\brendered\b/i.test(s.evidence), s.evidence);
});

test('H2/H6 a COMMENT or a STRING naming the governed surface does NOT pass the render check', () => {
  const stories = [readStory];
  const checks = deriveAcceptanceChecks(stories);
  for (const forgery of [
    '// os.datasets.query("ds_1")',
    '/* we will call os.datasets.query here later */',
    "const hint = 'os.datasets.query';\nexport const H = hint;",
    'export const Doc = () => <p>os.datasets.query</p>;',
    "import type { QueryResult } from '@sovereign-os/app-sdk';\nexport type R = QueryResult;",
  ]) {
    const files: SourceFile[] = [{ path: 'src/epics/e1/s1/Page.tsx', content: forgery }];
    const scores = scoreAcceptanceChecks(checks, stories, files, GREEN);
    const render = scores.find((s) => s.kind === 'render');
    assert.equal(render?.status, 'fail', `forgery passed: ${forgery}`);
    assert.ok(render?.evidence.includes('CALLS none of'), render?.evidence);
    assert.ok(render?.evidence.includes('a comment or a string naming one does not count'));
  }
});

test('H2 the write check is satisfied only by a real CALL to the write surface', () => {
  const stories = [writeStory];
  const checks = deriveAcceptanceChecks(stories);
  const real: SourceFile[] = [
    {
      path: 'src/epics/e1/s2/Claim.tsx',
      content:
        "import { createOsClient } from '@sovereign-os/app-sdk';\n" +
        'const os = createOsClient();\n' +
        'export const save = (r: Record<string, unknown>) => os.records.add(r);\n',
    },
  ];
  const render = scoreAcceptanceChecks(checks, stories, real, GREEN).find((s) => s.kind === 'render');
  assert.equal(render?.status, 'pass');
  assert.ok(render?.evidence.includes('calls os.records.add'));
  assert.ok(render?.evidence.includes('importing @sovereign-os/app-sdk'));
});

test('L-3 an unscored build reports `scored: false`, never a clean-looking total of 0', () => {
  const sum = acceptanceSummary([]);
  assert.equal(sum.scored, false);
  assert.equal(sum.ok, false, 'nothing scored can never be ok');
  assert.equal(sum.total, 0);
  assert.equal(sum.failed, 0);
  const report = formatAcceptanceReport(deriveAcceptanceChecks([readStory]), []);
  assert.ok(report.includes('NOT SCORED'), report);
  assert.ok(report.includes('5 derived check(s)'), report);
});

test('a story with no file FAILS its route check and leaves render UNDECIDABLE, not passed', () => {
  const stories = [readStory];
  const checks = deriveAcceptanceChecks(stories);
  const scores = scoreAcceptanceChecks(checks, stories, [{ path: 'src/Other.tsx', content: 'export const x = 1;' }], GREEN);
  const byId = new Map(scores.map((s) => [s.id, s]));
  assert.equal(byId.get('c2')?.status, 'fail');
  assert.equal(byId.get('c3')?.status, 'unknown');
  assert.ok(byId.get('c3')?.evidence.includes('route check failed first'));
  assert.equal(acceptanceSummary(scores).ok, false);
});

test('a write story whose file only READS fails the render check with the reason', () => {
  const stories = [writeStory];
  const checks = deriveAcceptanceChecks(stories);
  const files: SourceFile[] = [{ path: 'src/epics/e1/s2/Claim.tsx', content: 'await os.datasets.query("ds_1");' }];
  const scores = scoreAcceptanceChecks(checks, stories, files, GREEN);
  const render = scores.find((s) => s.kind === 'render');
  assert.equal(render?.status, 'fail');
  assert.ok(render?.evidence.includes('does not reach governed writes'));
});

test('H11 a red gate fails the compile check and names the diagnostics', () => {
  const checks = deriveAcceptanceChecks([readStory]);
  const scores = scoreAcceptanceChecks(checks, [readStory], [], RED);
  const compile = scores.find((s) => s.kind === 'compile');
  assert.equal(compile?.status, 'fail');
  assert.ok(compile?.evidence.includes('TS2304'));
});

test('an UNGATED shape is UNKNOWN, never a pass', () => {
  const checks = deriveAcceptanceChecks([readStory]);
  const scores = scoreAcceptanceChecks(checks, [readStory], [], UNGATED);
  const compile = scores.find((s) => s.kind === 'compile');
  assert.equal(compile?.status, 'unknown');
  assert.ok(compile?.evidence.includes('did not check this shape'));
  assert.equal(acceptanceSummary(scores).ok, false);
});

test('manual checks are never machine-passed and never block `ok`', () => {
  const stories = [readStory];
  const checks = deriveAcceptanceChecks(stories);
  const files: SourceFile[] = [{ path: 'src/epics/e1/s1/Page.tsx', content: 'await os.datasets.query("ds_1");' }];
  const scores = scoreAcceptanceChecks(checks, stories, files, GREEN);
  const manual = scores.filter((s) => s.status === 'manual');
  assert.equal(manual.length, 2);
  for (const m of manual) assert.ok(m.evidence.includes('for a human'));
  const sum = acceptanceSummary(scores);
  assert.equal(sum.ok, true, 'two outstanding MANUAL checks must not make the build not-ok');
  assert.equal(sum.manual, 2);
});

test('the report and the feedback name the unmet checks with their evidence', () => {
  const stories = [readStory];
  const checks = deriveAcceptanceChecks(stories);
  const scores = scoreAcceptanceChecks(checks, stories, [], RED);
  const report = formatAcceptanceReport(checks, scores);
  assert.ok(report.startsWith('Acceptance:'));
  assert.ok(report.includes('FAIL    [compile]'));
  assert.ok(report.includes('MANUAL  [manual]'));
  const feedback = acceptanceFeedback(checks, scores);
  assert.ok(feedback.includes('acceptance check(s) derived from the user stories are not satisfied'));
  assert.ok(feedback.includes('[compile]'));
  assert.ok(!feedback.includes('[manual]'), 'a manual check is never fed back as a coder failure');
  // Nothing unmet means no feedback at all.
  const green = scoreAcceptanceChecks(checks, stories, [{ path: 'src/epics/e1/s1/P.tsx', content: 'os.datasets.query("x")' }], GREEN);
  assert.equal(acceptanceFeedback(checks, green), '');
});
