/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    Tests for the bounded builder loop — including THE RECOVERY PROPERTY
 * USER STORY: As the owner who was told the harness is the problem I want proof that a first
 *             attempt which does not compile is rejected, the real diagnostics are fed back, and
 *             the second attempt lands — and that a build which never satisfies the stories is
 *             never reported as done.
 * ARCHITECTURE:
 *   - The loop's deps are INJECTED, so a SCRIPTED coder drives every property deterministically
 *     with no model and no network. One test additionally runs the REAL in-process compile gate
 *     over a real scaffold tree, so the recovery property is proved against the actual compiler
 *     rather than a stubbed verdict.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sovereignAppFiles } from '../scaffolds/sovereign-app.ts';
import { buildBuilderTree, mergeBuilderTree } from './tools.ts';
import { deriveAcceptanceChecks, type CompileOutcome } from './acceptance.ts';
import { MAX_BUILDER_ITERATIONS, runBuilderLoop, type BuilderLoopDeps, type BuilderStep } from './loop.ts';
import type { GroundingStory, SourceFile } from './grounding.ts';

const story: GroundingStory = {
  epicId: 'e1',
  storyId: 's1',
  title: 'See every open invoice',
  features: ['A table of open invoices'],
  nfrs: ['Loads in under two seconds'],
  rules: [],
};

/** A file set that satisfies the story's route AND render checks. */
const GOOD: SourceFile[] = [
  {
    path: 'src/epics/e1/s1/Page.tsx',
    content: "import { createOsClient } from '@sovereign-os/app-sdk';\nconst os = createOsClient();\nexport const rows = () => os.datasets.query('ds_1');\n",
  },
];
/** A file set that compiles (per the stub) but satisfies no story. */
const OFF_TARGET: SourceFile[] = [{ path: 'src/Unrelated.tsx', content: 'export const x = 1;\n' }];

const GREEN: CompileOutcome & { text: string } = { gated: true, ok: true, errors: [], text: 'compile check passed' };
const RED: CompileOutcome & { text: string } = {
  gated: true,
  ok: false,
  errors: ['src/epics/e1/s1/Page.tsx:1:10 TS2305: Module "@sovereign-os/ui" has no exported member Modal'],
  text: 'commit rejected: 1 compile error — NOTHING was written.\n  src/epics/e1/s1/Page.tsx:1:10  TS2305: no exported member Modal',
};

type Harness = {
  deps: BuilderLoopDeps;
  commits: { files: SourceFile[]; message: string }[];
  steps: BuilderStep[];
  coderSaw: (string | null)[];
};

/** A scripted harness: `plans[n]` is the file set the coder returns on iteration n+1. */
function harness(plans: SourceFile[][], compileOf: (files: SourceFile[]) => CompileOutcome & { text: string }, over: Partial<BuilderLoopDeps> = {}): Harness {
  const commits: { files: SourceFile[]; message: string }[] = [];
  const steps: BuilderStep[] = [];
  const coderSaw: (string | null)[] = [];
  const deps: BuilderLoopDeps = {
    plan: async () => '1. src/epics/e1/s1/Page.tsx — the invoice table, reading ds_1.',
    code: async ({ iteration, feedback }) => {
      coderSaw.push(feedback);
      const files = plans[iteration - 1] ?? plans[plans.length - 1];
      return { files, text: '' };
    },
    build: async (files) => compileOf(files),
    review: async ({ scores }) => (scores.every((s) => s.status === 'pass' || s.status === 'manual') ? { verdict: 'pass', notes: [] } : { verdict: 'revise', notes: [] }),
    commit: async (files, message) => {
      commits.push({ files, message });
      return { ok: true, detail: `committed ${files.length} file(s)` };
    },
    onStep: (s) => {
      steps.push(s);
    },
    ...over,
  };
  return { deps, commits, steps, coderSaw };
}

function input(prior: SourceFile[] = []) {
  return {
    appName: 'Invoices',
    grounding: '(grounding pack)',
    stories: [story],
    checks: deriveAcceptanceChecks([story]),
    prior,
    message: 'build all with the agentic builder',
  };
}

// --------------------------------------------------------- THE RECOVERY PROPERTY ---

test('H9 the first coder output fails to compile and the loop RECOVERS on iteration 2', async () => {
  const bad: SourceFile[] = [{ path: 'src/epics/e1/s1/Page.tsx', content: "import { Modal } from '@sovereign-os/ui';\n" }];
  const h = harness([bad, GOOD], (files) => (files === bad ? RED : GREEN));
  const r = await runBuilderLoop(input(), h.deps);

  assert.equal(r.ok, true);
  assert.equal(r.stopped, 'passed');
  assert.equal(r.iterations, 2, 'it must land on the SECOND iteration, not the first and not the fourth');
  // The coder got NOTHING on turn 1 and the compiler's own diagnostics on turn 2.
  assert.equal(h.coderSaw[0], null);
  assert.ok(h.coderSaw[1]?.includes('TS2305'), 'the real diagnostics must be fed back verbatim');
  assert.deepEqual(r.feedback.length, 1);
  // NOTHING was written for the red attempt; exactly ONE commit, of the good tree.
  assert.equal(h.commits.length, 1);
  assert.deepEqual(h.commits[0].files, GOOD);
  // H12 — every step is reported, in order, for the trace.
  assert.deepEqual(
    h.steps.map((s) => `${s.iteration}:${s.kind}`),
    ['0:plan', '1:code', '1:build', '2:code', '2:build', '2:review', '2:commit'],
  );
  assert.equal(h.steps.find((s) => s.iteration === 1 && s.kind === 'build')?.ok, false);
});

test('H9/H11 the recovery property holds against the REAL compile gate', async () => {
  const prior = sovereignAppFiles('Invoices', 'invoices') as SourceFile[];
  // A real TS error the gate catches: an export that does not exist in the vendored UI package.
  const bad: SourceFile[] = [
    { path: 'src/epics/e1/s1/Page.tsx', content: "import { Modal } from '@sovereign-os/ui';\nexport const P = () => Modal;\n" },
  ];
  const good: SourceFile[] = [
    {
      path: 'src/epics/e1/s1/Page.tsx',
      content:
        "import { Card } from '@sovereign-os/ui';\n" +
        "import { createOsClient } from '@sovereign-os/app-sdk';\n" +
        'const os = createOsClient();\n' +
        'export const P = () => Card;\n' +
        "export const rows = () => os.datasets.query('ds_1');\n",
    },
  ];
  const h = harness([bad, good], () => GREEN, { build: async (files) => buildBuilderTree(prior, files) });
  const r = await runBuilderLoop({ ...input(prior), checks: deriveAcceptanceChecks([story]) }, h.deps);

  // The gate's verdict is the real one, whichever way the environment can check this tree.
  if (!r.compile.gated) {
    assert.equal(r.iterations, 1, 'an ungated environment cannot prove recovery — it is reported honestly');
    assert.ok(r.compile.note);
    return;
  }
  assert.equal(r.iterations, 2, 'the real gate must reject attempt 1 and accept attempt 2');
  assert.ok(r.feedback[0].includes('Modal'), 'the real diagnostic must name the bad import');
  assert.equal(h.commits.length, 1, 'the red attempt wrote nothing');
});

// -------------------------------------------------------------------- the bounds ---

test('H8 the loop is bounded at four iterations and never commits a red tree', async () => {
  const attempts = [1, 2, 3, 4, 5].map((n): SourceFile[] => [{ path: `src/try${n}.tsx`, content: `export const n = ${n};\n` }]);
  const h = harness(attempts, () => RED);
  const r = await runBuilderLoop(input(), h.deps);

  assert.equal(r.ok, false);
  assert.equal(r.stopped, 'budget');
  assert.equal(r.iterations, MAX_BUILDER_ITERATIONS);
  assert.equal(MAX_BUILDER_ITERATIONS, 4);
  assert.equal(h.commits.length, 0, 'a tree that does not compile is NEVER committed');
  assert.equal(r.committed, null);
  assert.ok(r.summary.includes('NOTHING was committed'));
  assert.equal(h.steps.filter((s) => s.kind === 'code').length, 4);
});

test('H8 maxIterations can lower the bound but never raise it', async () => {
  const attempts = [1, 2, 3, 4, 5].map((n): SourceFile[] => [{ path: `src/try${n}.tsx`, content: `export const n = ${n};\n` }]);
  const low = harness(attempts, () => RED);
  assert.equal((await runBuilderLoop(input(), { ...low.deps, maxIterations: 2 })).iterations, 2);
  const high = harness(attempts, () => RED);
  assert.equal((await runBuilderLoop(input(), { ...high.deps, maxIterations: 99 })).iterations, MAX_BUILDER_ITERATIONS);
});

test('H8 an identical retry stops the loop as NO PROGRESS instead of burning the budget', async () => {
  const same: SourceFile[] = [{ path: 'src/same.tsx', content: 'export const x = 1;\n' }];
  const h = harness([same, same, same, same], () => RED);
  const r = await runBuilderLoop(input(), h.deps);
  assert.equal(r.stopped, 'no-progress');
  assert.equal(r.iterations, 2);
  assert.equal(h.commits.length, 0);
  assert.ok(r.summary.includes('byte-identical'));
});

test('a coder that throws stops the loop honestly and writes nothing', async () => {
  const h = harness([GOOD], () => GREEN, {
    code: async () => {
      throw new Error("the coder's reply was unusable: no `files` array");
    },
  });
  const r = await runBuilderLoop(input(), h.deps);
  assert.equal(r.ok, false);
  assert.equal(r.stopped, 'coder-error');
  assert.equal(h.commits.length, 0);
  assert.ok(r.summary.includes('unusable'));
});

// ------------------------------------------------------------------- the honesty ---

test('a GREEN tree that satisfies no story is committed on budget but reported NOT done', async () => {
  const h = harness([OFF_TARGET, OFF_TARGET.map((f) => ({ ...f, content: `${f.content}// 2\n` })), OFF_TARGET.map((f) => ({ ...f, content: `${f.content}// 3\n` })), OFF_TARGET.map((f) => ({ ...f, content: `${f.content}// 4\n` }))], () => GREEN);
  const r = await runBuilderLoop(input(), h.deps);
  assert.equal(r.ok, false, 'compiling is not the same as done');
  assert.equal(r.stopped, 'budget');
  assert.equal(h.commits.length, 1);
  assert.ok(h.commits[0].message.includes('acceptance incomplete'));
  assert.ok(r.summary.includes('This build is NOT done'));
  assert.ok(r.report.includes('FAIL'));
});

test('a reviewer PASS over an unmet scorecard is OVERRIDDEN and said out loud', async () => {
  const h = harness([OFF_TARGET, GOOD], () => GREEN, { review: async () => ({ verdict: 'pass', notes: [] }) });
  const r = await runBuilderLoop(input(), h.deps);
  assert.equal(r.iterations, 2, 'the loop must not stop on a reviewer pass the scorecard contradicts');
  assert.equal(r.ok, true);
  assert.ok(r.feedback[0].includes('overridden by the scorecard'));
});

test('a refused commit is reported as a commit-error, never as success', async () => {
  const h = harness([GOOD], () => GREEN, { commit: async () => ({ ok: false, detail: 'Forbidden: ds_9 is not granted' }) });
  const r = await runBuilderLoop(input(), h.deps);
  assert.equal(r.ok, false);
  assert.equal(r.stopped, 'commit-error');
  assert.equal(r.committed, null);
  assert.ok(r.summary.includes('Forbidden'));
});

test('no stories means no build, and the loop says why', async () => {
  const h = harness([GOOD], () => GREEN);
  const r = await runBuilderLoop({ ...input(), stories: [], checks: deriveAcceptanceChecks([]) }, h.deps);
  assert.equal(r.ok, false);
  assert.equal(r.stopped, 'no-stories');
  assert.equal(r.iterations, 0);
  assert.equal(h.commits.length, 0);
  assert.ok(r.summary.includes('Design at least one epic'));
});

test('a failing onStep hook never fails the build', async () => {
  const h = harness([GOOD], () => GREEN, {
    onStep: () => {
      throw new Error('langfuse is down');
    },
  });
  const r = await runBuilderLoop(input(), h.deps);
  assert.equal(r.ok, true);
});

test('mergeBuilderTree keeps the prior tree and lets the changeset win per path', () => {
  const prior: SourceFile[] = [
    { path: 'src/a.ts', content: 'old' },
    { path: 'src/b.ts', content: 'keep' },
  ];
  const merged = mergeBuilderTree(prior, [{ path: 'src/a.ts', content: 'new' }, { path: 'src/c.ts', content: 'added' }]);
  assert.deepEqual(merged, [
    { path: 'src/a.ts', content: 'new' },
    { path: 'src/b.ts', content: 'keep' },
    { path: 'src/c.ts', content: 'added' },
  ]);
});
