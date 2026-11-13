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
import type { RunTraceContext } from '@core/infra/langfuse';
import { commitToApp, getSnapshot, hydrateSnapshot } from '@tabs/software/lib/server';
import { templateFiles, type App } from '@tabs/software/lib/apps';
import type { BuildTarget } from '@tabs/software/lib/build-target';
import { deriveAcceptanceChecks, acceptanceSummary } from '@tabs/software/lib/builder/acceptance';
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
  const pack = overrides.pack ?? (await assembleGroundingPack(user, app, target));
  const grounding = renderGroundingPack(pack);
  const checks = deriveAcceptanceChecks(pack.stories);
  const prior = overrides.prior ?? (await priorTree(app));
  const label = targetLabelFor(target);

  const reason = completeAs(user, 'reasoning');
  const coder = completeAs(user, 'coder');

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
    review: async ({ report, compile }) => {
      const p = reviewerPrompt({ report, compileText: compile.ok ? 'compile check passed' : `compile: ${compile.errors.join(' | ')}` });
      const raw = await reason(p.system, p.user);
      return parseReviewReply(raw);
    },
    commit: async (files, message) => {
      try {
        const { step } = await commitToApp(app.id, user, files, message);
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
        ...(overrides.traceContext ? { run: overrides.traceContext } : {}),
      });
    },
    ...overrides.deps,
  };

  const result = await runBuilderLoop(
    {
      appName: app.name,
      grounding,
      stories: pack.stories,
      checks,
      prior,
      message: `build ${label} with the agentic builder`,
    },
    deps,
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
    steps: result.steps,
    summary: result.summary,
    next: result.ok
      ? 'Review the committed files, then verify_software. The MANUAL acceptance checks are yours to confirm.'
      : 'Nothing is done yet: read the acceptance report and the compile errors above, fix the brief or the grants, and build again.',
  };
}
