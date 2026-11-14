/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    The agentic builder LOOP — plan then code, build, review, bounded and iterated
 * USER STORY: As the owner who asked why good user stories do not become good software I want the
 *             builder to behave like an engineer: plan once, write code, COMPILE it, score it
 *             against the stories, and iterate on the real failures — not fill a schema once and
 *             hope.
 * ARCHITECTURE:
 *   - PURE ORCHESTRATION with INJECTED deps (`BuilderLoopDeps`): no model client, no store, no fs,
 *     no fetch in this module. That is what makes the recovery property testable with a scripted
 *     LLM (`loop.test.ts`) instead of a live model. `loop-server.ts` wires the real deps.
 *   - BOUNDED: at most `MAX_BUILDER_ITERATIONS` (4) coder turns, and the loop also stops early on
 *     NO PROGRESS (a byte-identical retry) and on a coder error. It can never spin.
 *   - WRITE DISCIPLINE: the loop commits ONLY through the injected governed door, and only when
 *     the tree COMPILES. A red gate writes nothing. A green tree whose story checks are unmet is
 *     committed on budget exhaustion but reported `ok: false` with the unmet checks named — a
 *     build is never called a success because it merely compiled.
 *   - EVERY step is reported through `onStep` so the caller traces it (Langfuse) and shows it.
 *   - NOTHING THROWS OUT. All four model/tool deps are wrapped (review M-4): a planner outage, an
 *     esbuild or OOM slip in the build tool, and a reviewer failure each end the loop with their
 *     own typed stop reason and an honest summary, exactly as a coder error already did. A raw
 *     exception escaping `agenticBuild` would reach the MCP boundary as an untyped 500 and lose
 *     the step trail that says how far the build got.
 */

import {
  acceptanceFeedback,
  acceptanceSummary,
  formatAcceptanceReport,
  scoreAcceptanceChecks,
  type AcceptanceCheck,
  type CheckScore,
  type CompileOutcome,
} from '@tabs/software/lib/builder/acceptance';
import type { GroundingStory, SourceFile } from '@tabs/software/lib/builder/grounding';

/** The hard iteration ceiling. Four is a real engineer's patience and a bounded token budget. */
export const MAX_BUILDER_ITERATIONS = 4;

export type BuilderStepKind = 'plan' | 'code' | 'build' | 'review' | 'commit';

/** One recorded step of the loop — what the trace, the activity feed and the result all show. */
export type BuilderStep = {
  iteration: number;
  kind: BuilderStepKind;
  ok: boolean;
  summary: string;
};

/** What a coder turn produced. `files` is a CHANGESET over the prior tree. */
export type CoderOutput = { files: SourceFile[]; text: string };

/** The reviewer's decision. `revise` means loop; `pass` means commit and stop. */
export type ReviewOutcome = { verdict: 'pass' | 'revise'; notes: string[] };

/** The governed commit door's outcome, as the loop needs it. */
export type CommitOutcome = { ok: boolean; detail: string };

export type BuilderLoopDeps = {
  /** Reasoning-tier plan, once, from the grounding pack and the acceptance checks. */
  plan: (input: { grounding: string; checks: AcceptanceCheck[] }) => Promise<string>;
  /** Coder-tier code. `feedback` is null on the first turn and the exact failures after that. */
  code: (input: {
    iteration: number;
    grounding: string;
    plan: string;
    checks: AcceptanceCheck[];
    prior: SourceFile[];
    feedback: string | null;
  }) => Promise<CoderOutput>;
  /** The build tool: compile the changeset over the prior tree and return real diagnostics. */
  build: (files: SourceFile[]) => Promise<CompileOutcome & { text: string }>;
  /** The reviewer: reads the scorecard and decides loop or stop. */
  review: (input: {
    iteration: number;
    checks: AcceptanceCheck[];
    scores: CheckScore[];
    report: string;
    compile: CompileOutcome;
  }) => Promise<ReviewOutcome>;
  /** The governed file-write door — called at most once, and only over a COMPILING tree. */
  commit: (files: SourceFile[], message: string) => Promise<CommitOutcome>;
  /** Observability hook — one call per step, in order. Never allowed to fail the loop. */
  onStep?: (step: BuilderStep) => void | Promise<void>;
  /** Override the ceiling downwards (a budget-aware caller); never above the hard max. */
  maxIterations?: number;
};

export type BuilderLoopInput = {
  appName: string;
  /** The rendered grounding pack. */
  grounding: string;
  stories: GroundingStory[];
  checks: AcceptanceCheck[];
  /** The app's current committed tree (the changeset is merged over it by the build tool). */
  prior: SourceFile[];
  /** Commit message for the one write. */
  message: string;
};

/** Why the loop stopped. Only `passed` is a success. */
export type BuilderStopReason =
  | 'passed'
  | 'budget'
  | 'no-progress'
  /** The planner, coder, build tool or reviewer THREW — a model outage, an esbuild/OOM slip, a
   *  bad reply. Each gets its own reason so the caller can say which stage failed (review M-4). */
  | 'plan-error'
  | 'coder-error'
  | 'build-error'
  | 'review-error'
  | 'commit-error'
  | 'no-stories';

export type BuilderLoopResult = {
  ok: boolean;
  stopped: BuilderStopReason;
  iterations: number;
  steps: BuilderStep[];
  plan: string;
  /** The last coder changeset (whatever the loop ended on), so the caller can show it. */
  files: SourceFile[];
  compile: CompileOutcome;
  scores: CheckScore[];
  report: string;
  committed: { files: number; detail: string } | null;
  /** The feedback the coder was given, one entry per retry — the loop's own audit trail. */
  feedback: string[];
  summary: string;
};

/** Stable fingerprint of a changeset, for the no-progress guard. */
function fingerprint(files: SourceFile[]): string {
  return [...files]
    .map((f) => `${f.path} ${f.content}`)
    .sort()
    .join('');
}

const EMPTY_COMPILE: CompileOutcome = {
  gated: false,
  ok: false,
  errors: [],
  note: 'the loop never produced a tree to compile',
};

function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim().length > 0) ?? '';
  return line.length > 200 ? `${line.slice(0, 200)}...` : line;
}

/**
 * Run the bounded builder loop. Deterministic given deterministic deps — the recovery property
 * (first coder output fails to compile, iteration 2 recovers) is asserted from a scripted LLM.
 */
export async function runBuilderLoop(input: BuilderLoopInput, deps: BuilderLoopDeps): Promise<BuilderLoopResult> {
  const steps: BuilderStep[] = [];
  const feedbackLog: string[] = [];
  const maxIterations = Math.max(1, Math.min(deps.maxIterations ?? MAX_BUILDER_ITERATIONS, MAX_BUILDER_ITERATIONS));
  const record = async (step: BuilderStep): Promise<void> => {
    steps.push(step);
    try {
      await deps.onStep?.(step);
    } catch {
      /* observability is best-effort — it must never fail a build */
    }
  };
  const done = (r: Omit<BuilderLoopResult, 'steps' | 'feedback'>): BuilderLoopResult => ({
    ...r,
    steps,
    feedback: feedbackLog,
  });

  if (input.stories.length === 0) {
    await record({ iteration: 0, kind: 'plan', ok: false, summary: 'no user stories — nothing to build from' });
    return done({
      ok: false,
      stopped: 'no-stories',
      iterations: 0,
      plan: '',
      files: [],
      compile: EMPTY_COMPILE,
      scores: [],
      report: '',
      committed: null,
      summary: 'Design at least one epic with a user story first — the builder builds from the stories.',
    });
  }

  /** Run a dep, or end the loop with its own typed stop reason. `null` means "already finished". */
  const guard = async <T>(
    kind: BuilderStepKind,
    iteration: number,
    stopped: BuilderStopReason,
    fn: () => Promise<T>,
    partial: () => Omit<BuilderLoopResult, 'steps' | 'feedback' | 'ok' | 'stopped' | 'summary'>,
  ): Promise<{ ok: true; value: T } | { ok: false; result: BuilderLoopResult }> => {
    try {
      return { ok: true, value: await fn() };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await record({ iteration, kind, ok: false, summary: `${kind} failed: ${message}` });
      return {
        ok: false,
        result: done({
          ...partial(),
          ok: false,
          stopped,
          summary: `The build stopped in the ${kind} stage at iteration ${iteration}: ${message}. Nothing was committed.`,
        }),
      };
    }
  };

  const planned = await guard('plan', 0, 'plan-error', () => deps.plan({ grounding: input.grounding, checks: input.checks }), () => ({
    iterations: 0,
    plan: '',
    files: [],
    compile: EMPTY_COMPILE,
    scores: [],
    report: '',
    committed: null,
  }));
  if (!planned.ok) return planned.result;
  const plan = planned.value;
  await record({ iteration: 0, kind: 'plan', ok: true, summary: firstLine(plan) });

  let feedback: string | null = null;
  let lastFiles: SourceFile[] = [];
  let lastPrint = '';
  let compile: CompileOutcome & { text: string } = { ...EMPTY_COMPILE, text: '' };
  let scores: CheckScore[] = [];
  let report = '';

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    const partial = () => ({ iterations: iteration, plan, files: lastFiles, compile, scores, report, committed: null });
    const coded = await guard('code', iteration, 'coder-error', () =>
      deps.code({ iteration, grounding: input.grounding, plan, checks: input.checks, prior: input.prior, feedback }), partial);
    if (!coded.ok) return coded.result;
    const out: CoderOutput = coded.value;
    await record({
      iteration,
      kind: 'code',
      ok: out.files.length > 0,
      summary: `${out.files.length} file(s): ${out.files.map((f) => f.path).join(', ') || '(none)'}`,
    });

    const print = fingerprint(out.files);
    if (iteration > 1 && print === lastPrint) {
      await record({ iteration, kind: 'review', ok: false, summary: 'no progress — the coder returned an identical file set' });
      return done({
        ok: false,
        stopped: 'no-progress',
        iterations: iteration,
        plan,
        files: out.files,
        compile,
        scores,
        report,
        committed: null,
        summary: `The build stopped at iteration ${iteration}: the coder returned a byte-identical file set after being told what failed. Nothing was committed.`,
      });
    }
    lastFiles = out.files;
    lastPrint = print;

    const built = await guard('build', iteration, 'build-error', () => deps.build(out.files), partial);
    if (!built.ok) return built.result;
    compile = built.value;
    await record({
      iteration,
      kind: 'build',
      ok: compile.ok,
      summary: compile.ok
        ? 'compile passed'
        : compile.gated
          ? `compile failed with ${compile.errors.length} error(s)`
          : `compile not checked: ${compile.note ?? 'ungated shape'}`,
    });

    if (compile.gated && !compile.ok) {
      // RED GATE: nothing is written, and the coder gets the compiler's own diagnostics back.
      feedback = compile.text;
      feedbackLog.push(feedback);
      continue;
    }

    scores = scoreAcceptanceChecks(input.checks, input.stories, out.files, compile);
    report = formatAcceptanceReport(input.checks, scores);
    const summary = acceptanceSummary(scores);
    const reviewed = await guard('review', iteration, 'review-error', () =>
      deps.review({ iteration, checks: input.checks, scores, report, compile }), partial);
    if (!reviewed.ok) return reviewed.result;
    const review = reviewed.value;
    await record({
      iteration,
      kind: 'review',
      ok: review.verdict === 'pass',
      summary: `${review.verdict} — ${summary.passed} passed / ${summary.failed} failed / ${summary.unknown} unknown`,
    });

    if (review.verdict === 'pass' && summary.ok) {
      const committed = await guard('commit', iteration, 'commit-error', () => deps.commit(out.files, input.message), partial);
      if (!committed.ok) return committed.result;
      const commit = committed.value;
      await record({ iteration, kind: 'commit', ok: commit.ok, summary: commit.detail });
      return done({
        ok: commit.ok,
        stopped: commit.ok ? 'passed' : 'commit-error',
        iterations: iteration,
        plan,
        files: out.files,
        compile,
        scores,
        report,
        committed: commit.ok ? { files: out.files.length, detail: commit.detail } : null,
        summary: commit.ok
          ? `Built ${input.appName} in ${iteration} iteration(s): ${summary.passed} acceptance check(s) passed, ${summary.manual} left for you to confirm. ${commit.detail}`
          : `The tree compiled and passed its checks, but the governed commit was refused: ${commit.detail}. Nothing was written.`,
      });
    }

    // A reviewer `pass` over an UNMET scorecard is not a pass. Say so and keep looping.
    const notes =
      review.verdict === 'pass' && !summary.ok
        ? ['the reviewer passed a scorecard that still has unmet checks — overridden by the scorecard']
        : review.notes;
    feedback = [acceptanceFeedback(input.checks, scores), ...notes.map((n) => `- reviewer: ${n}`)]
      .filter((s) => s.length > 0)
      .join('\n');
    feedbackLog.push(feedback);
  }

  // BUDGET EXHAUSTED. If the last tree COMPILES we commit it (the work is real and the compile
  // gate is the write gate) but we report `ok: false` and name the unmet checks — a build that
  // does not satisfy its stories is never reported as done.
  const summary = acceptanceSummary(scores);
  if (compile.gated && compile.ok && lastFiles.length > 0) {
    const committed = await guard('commit', maxIterations, 'commit-error', () =>
      deps.commit(lastFiles, `${input.message} (acceptance incomplete)`), () => ({
      iterations: maxIterations,
      plan,
      files: lastFiles,
      compile,
      scores,
      report,
      committed: null,
    }));
    if (!committed.ok) return committed.result;
    const commit = committed.value;
    await record({ iteration: maxIterations, kind: 'commit', ok: commit.ok, summary: commit.detail });
    return done({
      ok: false,
      stopped: commit.ok ? 'budget' : 'commit-error',
      iterations: maxIterations,
      plan,
      files: lastFiles,
      compile,
      scores,
      report,
      committed: commit.ok ? { files: lastFiles.length, detail: commit.detail } : null,
      summary: `Ran out of the ${maxIterations}-iteration budget. The tree COMPILES and was committed, but ${summary.failed} acceptance check(s) derived from your stories are still unmet and ${summary.unknown} could not be decided — see the scorecard. This build is NOT done.`,
    });
  }
  return done({
    ok: false,
    stopped: 'budget',
    iterations: maxIterations,
    plan,
    files: lastFiles,
    compile,
    scores,
    report,
    committed: null,
    summary:
      `Ran out of the ${maxIterations}-iteration budget with a tree that does not compile. NOTHING was committed, ` +
      `and the ${input.checks.length} acceptance check(s) derived from your stories were NEVER SCORED. ` +
      `Last diagnostics: ${compile.errors.slice(0, 3).join(' | ') || compile.note || 'none recorded'}`,
  });
}
