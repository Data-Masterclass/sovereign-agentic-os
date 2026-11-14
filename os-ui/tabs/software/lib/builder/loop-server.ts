/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    The agentic builder, wired — the one governed entry point the Build dispatch calls
 * USER STORY: As the signed-in user pressing Build I want the OS to plan, write, COMPILE, score
 *             against my stories and iterate — writing the files through the same governed door
 *             the UI and the MCP already use, as me, with every step in the run's trace.
 * ARCHITECTURE:
 *   - The ONE place the pure pieces are wired to the real world: the grounding pack
 *     (`grounding-server.ts`), the acceptance checks (`acceptance.ts`), the prompts
 *     (`prompts.ts`), the build tool (`tools.ts` over the existing `compileGate`), the bounded
 *     loop (`loop.ts`) and the governed file-write door (`commitToApp`).
 *   - IDENTITY: `commitToApp(appId, user, …)` is the SAME door the chat `commit` tool and the
 *     platform MCP use, run as the signed-in user. The builder adds no second write path and no
 *     service principal. By S's contract the same door becomes the `apps/<slug>/` git commit.
 *   - MODELS: the planner and reviewer run on the `reasoning` role; the coder runs on the new
 *     `coder` role, which falls back to `reasoning` when a deployment has not pinned one.
 *   - OBSERVABILITY: one governed `trace` span per loop step through `core/infra/agent-governed`,
 *     nested under the run's trace when the caller supplies one.
 *   - HONESTY: a model that is not configured, a refused commit, a red gate or an exhausted budget
 *     all surface as typed, labelled results. Nothing here can report success it did not achieve.
 */
import 'server-only';
import type { CurrentUser } from '@core/kernel/auth';
import { assistantComplete } from '@core/runtime/complete';
import { roleModel } from '@core/models/roles';
import { trace } from '@core/infra/agent-governed';
import { currentSurface } from '@core/infra/request-surface';
import type { RunTraceContext } from '@core/infra/langfuse';
import { commitToApp, getSnapshot, hydrateSnapshot } from '@tabs/software/lib/server';
import { templateFiles, type App } from '@tabs/software/lib/apps';
import type { BuildTarget } from '@tabs/software/lib/build-target';
import { deriveAcceptanceChecks, acceptanceSummary, type AcceptanceCheck, type CheckScore } from '@tabs/software/lib/builder/acceptance';
import {
  groundingSummary,
  renderGroundingPack,
  type GroundingPack,
  type SourceFile,
} from '@tabs/software/lib/builder/grounding';
import { assembleGroundingPack, targetLabelFor } from '@tabs/software/lib/builder/grounding-server';
import { buildBuilderTree } from '@tabs/software/lib/builder/tools';
import { runBuilderLoop, type BuilderLoopDeps, type BuilderLoopResult, type BuilderStep } from '@tabs/software/lib/builder/loop';
import { coderPrompt, parseCoderReply, parseReviewReply, plannerPrompt, reviewerPrompt } from '@tabs/software/lib/builder/prompts';
import { checkCap } from '@core/policy/cost';
import { MAX_BUILDER_ITERATIONS } from '@tabs/software/lib/builder/loop';

/**
 * ROUGH per-iteration cost of a builder turn in USD — a planner/coder/reviewer round on the
 * reasoning tier. Deliberately coarse: it exists to stop the loop from starting four iterations it
 * cannot pay for, not to bill anything. Over-estimating is the safe direction.
 */
export const BUILDER_ITERATION_COST_USD = 0.5;

/**
 * BUDGET-AWARE ITERATION BOUND (review L-1). The loop's ceiling is `MAX_BUILDER_ITERATIONS`; this
 * lowers it to what the caller's domain cap can still pay for, so a build near its cap does two
 * honest iterations instead of failing mid-way through the fourth with a `CostCapExceededError`
 * that loses the trail. No cap configured means no lowering. Never raises the ceiling.
 */
export function builderIterationBudget(user: CurrentUser, perIterationUsd = BUILDER_ITERATION_COST_USD): number | undefined {
  const domain = user.activeDomain ?? user.domains[0];
  if (!domain) return undefined;
  const probe = checkCap({ scope: 'domain', subject: domain, amount: 0 });
  if (!probe.cap) return undefined; // no cap set -> the loop's own bound is the only bound
  const headroom = probe.cap.limit - probe.projected;
  if (headroom <= 0) return 1; // over cap already: one iteration, which will fail honestly and say so
  return Math.max(1, Math.min(MAX_BUILDER_ITERATIONS, Math.floor(headroom / perIterationUsd)));
}

/**
 * WHERE THE ACCEPTANCE RESULT IS PERSISTED (review M-5). The deploy review card needs to show
 * whether the build satisfied its stories. The narrowest additive path that does NOT touch stream
 * S's files is the COMMITTED TREE itself: one `.app/acceptance.json` written by the SAME governed
 * `commitToApp` call that writes the code, in the same commit. So it is versioned with the code it
 * describes, it needs no `App` schema field, it is readable by `read_app_files` / the review card /
 * the MCP with no new tool, and a rollback to an earlier commit carries the matching scorecard.
 * See deviation H-review-5 for the merger: if S later adds an `App` field, this file stays the
 * source of truth and the field becomes its cache.
 */
export const ACCEPTANCE_FILE = '.app/acceptance.json';

/** The persisted record. Deliberately small, and `scored:false` is a first-class state. */
export type AcceptanceRecord = {
  version: 1;
  appId: string;
  target: string;
  builder: 'agentic';
  at: string;
  by: string;
  /**
   * WHY this scorecard was written, as it was true AT WRITE TIME: `acceptance-passed` (the reviewer
   * passed a clean scorecard) or `acceptance-incomplete` (the tree compiled but the budget ran out
   * with checks unmet — the commit message says so too). Never a running state: this file is only
   * ever written by a commit, so "in progress" would be a lie an approver could misread.
   */
  reason: 'acceptance-passed' | 'acceptance-incomplete';
  iterations: number;
  scored: boolean;
  ok: boolean;
  total: number;
  passed: number;
  failed: number;
  manual: number;
  unknown: number;
  /** The derived checks and their scores, so the card can show WHICH story is unmet. */
  checks: { id: string; kind: AcceptanceCheck['kind']; story: string; check: string; status: string; evidence: string }[];
  /** What the grounding pack could not supply — an approver should see a thin brief. */
  groundingGaps: string[];
};

/** Build the acceptance record a build commits beside its code. Pure. */
export function acceptanceRecord(input: {
  appId: string;
  target: string;
  userId: string;
  iterations: number;
  checks: AcceptanceCheck[];
  scores: CheckScore[];
  groundingGaps: string[];
  at?: string;
}): AcceptanceRecord {
  const sum = acceptanceSummary(input.scores);
  const byId = new Map(input.scores.map((s) => [s.id, s]));
  return {
    version: 1,
    appId: input.appId,
    target: input.target,
    builder: 'agentic',
    at: input.at ?? new Date().toISOString(),
    by: input.userId,
    reason: sum.ok ? 'acceptance-passed' : 'acceptance-incomplete',
    iterations: input.iterations,
    scored: sum.scored,
    ok: sum.ok,
    total: sum.total,
    passed: sum.passed,
    failed: sum.failed,
    manual: sum.manual,
    unknown: sum.unknown,
    checks: input.checks.map((c) => ({
      id: c.id,
      kind: c.kind,
      story: c.storyId ? `${c.epicId}/${c.storyId}` : 'build',
      check: c.check,
      status: byId.get(c.id)?.status ?? 'not-scored',
      evidence: byId.get(c.id)?.evidence ?? 'not scored',
    })),
    groundingGaps: [...input.groundingGaps],
  };
}

/** What the Build dispatch returns when the agentic builder ran. */
export type AgenticBuildResult = {
  stage: 'build';
  builder: 'agentic';
  appId: string;
  target: string;
  ok: boolean;
  stopped: BuilderLoopResult['stopped'];
  iterations: number;
  /** The grounding the build was given — one honest line, plus what it could not get. */
  grounding: { summary: string; gaps: string[] };
  /** The acceptance checks derived from the stories, and how they scored. */
  acceptance: {
    /** FALSE when the build never produced a scoreable tree — `total: 0` alone reads clean (L-3). */
    scored: boolean;
    total: number;
    passed: number;
    failed: number;
    manual: number;
    unknown: number;
    report: string;
  };
  compile: { gated: boolean; ok: boolean; errors: string[]; note?: string };
  files: string[];
  committed: { files: number; detail: string } | null;
  /** The committed path of the acceptance scorecard, or null when nothing was written (M-5). */
  acceptanceFile: string | null;
  steps: BuilderStep[];
  summary: string;
  next: string;
};

/** Injection seam: tests drive the loop without a model, a store or a compiler. */
export type AgenticBuildOverrides = {
  pack?: GroundingPack;
  prior?: SourceFile[];
  deps?: Partial<BuilderLoopDeps>;
  traceContext?: RunTraceContext;
};

/** The app's current committed tree, hydrated from the durable mirror on a cold process. */
async function priorTree(app: App): Promise<SourceFile[]> {
  await hydrateSnapshot(app.id);
  return getSnapshot(app.id) ?? templateFiles(app.template, app.name, app.slug);
}

function completeAs(user: CurrentUser, role: 'reasoning' | 'coder') {
  return async (system: string, userText: string): Promise<string> => {
    const { content } = await assistantComplete(
      [
        { role: 'system', content: system },
        { role: 'user', content: userText },
      ],
      { model: roleModel(role), user: { id: user.id, domains: user.domains } },
    );
    return content;
  };
}

/**
 * Run the agentic builder for one app + target. This is what the single guarded line in the Build
 * dispatch calls when `SOFTWARE_BUILDER=agentic`.
 */
export async function agenticBuild(
  user: CurrentUser,
  app: App,
  target: BuildTarget,
  overrides: AgenticBuildOverrides = {},
): Promise<AgenticBuildResult> {
  // L-2: when the Build dispatch runs INSIDE an agent run, the governed surface already carries the
  // run id (set by the granted-tool executor), so the builder's spans nest under the run's trace
  // with no new argument at the call site — the one guarded line in `platform-mcp.ts` stays one line.
  const traceContext: RunTraceContext | undefined =
    overrides.traceContext ?? (currentSurface()?.runId ? { traceId: currentSurface()!.runId! } : undefined);
  const pack = overrides.pack ?? (await assembleGroundingPack(user, app, target));
  const grounding = renderGroundingPack(pack);
  const checks = deriveAcceptanceChecks(pack.stories);
  const prior = overrides.prior ?? (await priorTree(app));
  const label = targetLabelFor(target);

  const reason = completeAs(user, 'reasoning');
  const coder = completeAs(user, 'coder');

  // The loop hands the commit dep only (files, message), so the scorecard it should carry is
  // captured here as the loop reports it. A commit happens BEFORE the loop returns, so the record
  // states what was true at WRITE time — which is exactly what an approver needs.
  let lastScores: CheckScore[] = [];
  let lastIteration = 0;

  const deps: BuilderLoopDeps = {
    plan: async ({ grounding: g, checks: c }) => {
      const p = plannerPrompt(g, c);
      return reason(p.system, p.user);
    },
    code: async ({ grounding: g, plan, checks: c, prior: pr, feedback }) => {
      const p = coderPrompt({ grounding: g, plan, checks: c, prior: pr, feedback });
      const raw = await coder(p.system, p.user);
      const parsed = parseCoderReply(raw);
      if (!parsed.ok) throw new Error(`the coder's reply was unusable: ${parsed.reason}`);
      const text = parsed.refused.length > 0 ? `dropped ${parsed.refused.length} refused path(s): ${parsed.refused.join('; ')}` : '';
      return { files: parsed.files, text };
    },
    build: async (files) => buildBuilderTree(prior, files),
    review: async ({ iteration, scores, report, compile }) => {
      lastScores = scores;
      lastIteration = iteration;
      const p = reviewerPrompt({ report, compileText: compile.ok ? 'compile check passed' : `compile: ${compile.errors.join(' | ')}` });
      const raw = await reason(p.system, p.user);
      return parseReviewReply(raw);
    },
    commit: async (files, message) => {
      // M-5: the scorecard rides in the SAME governed commit as the code it describes, so the
      // deploy card and an auditor read one commit, never a result that outlived its tree.
      const record = acceptanceRecord({
        appId: app.id,
        target: label,
        userId: user.id,
        iterations: lastIteration,
        checks,
        scores: lastScores,
        groundingGaps: pack.gaps,
      });
      const withRecord = [...files, { path: ACCEPTANCE_FILE, content: `${JSON.stringify(record, null, 2)}\n` }];
      try {
        const { step } = await commitToApp(app.id, user, withRecord, message);
        return { ok: step.ok !== false, detail: step.detail };
      } catch (e) {
        return { ok: false, detail: e instanceof Error ? e.message : String(e) };
      }
    },
    onStep: async (step) => {
      await trace({
        principal: user.id,
        tool: `appsmith.${step.kind}`,
        input: { appId: app.id, target: label, iteration: step.iteration },
        output: { ok: step.ok, summary: step.summary },
        ...(traceContext ? { run: traceContext } : {}),
      });
    },
    ...overrides.deps,
  };

  const budgeted = builderIterationBudget(user);
  const result = await runBuilderLoop(
    {
      appName: app.name,
      grounding,
      stories: pack.stories,
      checks,
      prior,
      message: `build ${label} with the agentic builder`,
    },
    { ...deps, ...(budgeted !== undefined ? { maxIterations: budgeted } : {}) },
  );

  const sum = acceptanceSummary(result.scores);
  return {
    stage: 'build',
    builder: 'agentic',
    appId: app.id,
    target: label,
    ok: result.ok,
    stopped: result.stopped,
    iterations: result.iterations,
    grounding: { summary: groundingSummary(pack), gaps: pack.gaps },
    acceptance: {
      scored: sum.scored,
      total: sum.total,
      passed: sum.passed,
      failed: sum.failed,
      manual: sum.manual,
      unknown: sum.unknown,
      report: result.report,
    },
    compile: {
      gated: result.compile.gated,
      ok: result.compile.ok,
      errors: result.compile.errors,
      ...(result.compile.note ? { note: result.compile.note } : {}),
    },
    files: result.files.map((f) => f.path),
    committed: result.committed,
    /** Where the scorecard landed, when a commit happened (review M-5). */
    acceptanceFile: result.committed ? ACCEPTANCE_FILE : null,
    steps: result.steps,
    summary: result.summary,
    next: result.ok
      ? 'Review the committed files, then verify_software. The MANUAL acceptance checks are yours to confirm.'
      : 'Nothing is done yet: read the acceptance report and the compile errors above, fix the brief or the grants, and build again.',
  };
}
