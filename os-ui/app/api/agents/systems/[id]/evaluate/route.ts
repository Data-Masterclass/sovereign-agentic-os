/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import { getSystem } from '@tabs/agents/lib/store';
import { assistantComplete } from '@core/runtime/complete';
import { judgeRun, type JudgeComplete } from '@tabs/agents/lib/evaluate-judge';
import { getWorkflow } from '@tabs/knowledge/lib/store';
import { scoreTrace } from '@core/infra/langfuse';
import { isRunId } from '@core/kernel/run-id';
import { assertRunVisible } from '@tabs/agents/lib/engine/run-visibility';
import { peekRunOwner } from '@tabs/agents/lib/build/agentic-graph-server';
import type { CurrentUser } from '@core/kernel/auth';
import type { System } from '@tabs/agents/lib/system-schema';

export const dynamic = 'force-dynamic';

/**
 * Gather the SUCCESS CRITERIA the team was actually given, so the judge scores
 * against the real task, not a generic one: the workflow-level tacit doc + every
 * per-step tacit note from each GRANTED knowledge workflow. Read governed as the
 * caller; a workflow we can't read is skipped (never fails the evaluation). Bounded
 * so a huge playbook can't blow the judge's context.
 */
function gatherGrantedCriteria(system: System, user: CurrentUser): string {
  const parts: string[] = [];
  for (const g of system.grants.knowledge) {
    try {
      const wf = getWorkflow(g.id, user);
      if (wf.tacit?.trim()) parts.push(wf.tacit.trim());
      for (const s of wf.workflow?.steps ?? []) if (s.tacit?.trim()) parts.push(`- ${s.tacit.trim()}`);
    } catch {
      /* not readable / not found — skip, never fail the evaluation */
    }
  }
  return parts.join('\n').slice(0, 4000);
}

/**
 * The system's stated purpose, as the judge's "task Description". Mirrors the run
 * route's `defaultRunTask` (name + domain) so the judge scores against the SAME job
 * the team was asked to do — no new persisted description field is introduced.
 */
function systemDescription(system: { system: { name: string; domain: string } }): string {
  const name = system.system.name?.trim() || 'this team';
  const domain = system.system.domain?.trim();
  const scope = domain ? ` over the ${domain} domain` : '';
  return `Do your standard job as the ${name}${scope}: assess the current state, then produce concrete recommended actions with the reasons behind them.`;
}

/**
 * POST → run the LLM-judge on the last run's final output. It scores Clarity ·
 * Grounding · Actionability (1–5 + why) against the system's task Description and any
 * granted-workflow tacit knowledge the client passes. The scoring goes through the
 * ONE governed assistant/standard model via `assistantComplete` (Langfuse-audited);
 * no new model client is created. The judge logic itself is the pure, unit-tested
 * `judgeRun` in `lib/agents/evaluate-judge.ts`.
 */
export const POST = withRoute<{ id: string }, {
  output?: string;
  description?: string;
  tacitKnowledge?: string;
  /** The run being judged (defaults to the persisted last run) — its trace receives the score. */
  runId?: string;
}>(async ({ user, params, body }) => {
  const { id } = params;

  // Edit-scope: getSystem enforces read access (owner / in-domain); reuse its view.
  const view = getSystem(id, user);

  // A5-review-M-3: THE OWNER GATE, before the judge runs and long before `scoreTrace`.
  // `getSystem` is read-scope (owner OR in-domain), so on a Shared system `view.lastRun`
  // can be a COLLEAGUE's run — and a `runId` in the body is the caller's own choice. A score
  // is a write on that run's Langfuse trace, so only the user who started the run may land
  // one. An explicitly requested foreign/unknown run id is a 404 (the same answer a run that
  // does not exist gives, so the id leaks nothing); the implicit fall-back to `lastRun` simply
  // scores nothing, because the caller never asked for that run and still wants the verdict.
  const requestedRunId = typeof body.runId === 'string' && body.runId.trim() ? body.runId.trim() : '';
  const targetRunId = requestedRunId || view.lastRun?.runId || '';
  let scorable = false;
  if (isRunId(targetRunId) && targetRunId === view.lastRun?.runId) {
    const owner = await peekRunOwner(targetRunId).catch(() => null);
    const record = owner ? { requestedBy: owner.userId, systemId: owner.systemId } : null;
    if (requestedRunId) {
      assertRunVisible(record, targetRunId, user.id, id);
      scorable = true;
    } else {
      scorable = !!record && record.requestedBy === user.id && record.systemId === id;
    }
  }

  // Prefer the output the client just saw; fall back to the persisted last run.
  const output = (typeof body.output === 'string' && body.output.trim())
    ? body.output
    : (view.lastRun?.output ?? '');
  if (!output.trim()) {
    return NextResponse.json({ error: 'Run the team first — there is no output to evaluate yet.' }, { status: 400 });
  }

  // Task description: an explicit override, else the persisted Define description
  // (the author's own words), else the generic fallback — so the judge scores the
  // REAL task whenever the team stated one.
  const description = (typeof body.description === 'string' && body.description.trim())
    ? body.description
    : (view.system.system.description?.trim() || systemDescription(view.system));

  // Success criteria: an explicit override, else auto-gathered from the granted
  // knowledge workflows' tacit notes — so grounding is judged against the actual rules.
  const tacitKnowledge = (typeof body.tacitKnowledge === 'string' && body.tacitKnowledge.trim())
    ? body.tacitKnowledge
    : gatherGrantedCriteria(view.system, user);

  // Route the judge through the ONE governed assistant model (Langfuse-audited), attributed to
  // the caller AND their domain (A3: per-domain spend).
  const complete: JudgeComplete = (messages) =>
    assistantComplete(messages, { user: { id: user.id, domains: user.domains } }).then((r) => r.content);

  const result = await judgeRun({ output, description, tacitKnowledge }, complete);
  // A3 (checklist A22): the verdict is a Langfuse SCORE on the run's trace (id = run id). Every
  // run has such a trace since A5; a run recorded before the rebuild has none, and one whose
  // owner is not the caller is never scored (the gate above) — both keep the verdict in the
  // response alone.
  const runId = targetRunId;
  const scored = scorable
    ? scoreTrace({
        traceId: runId,
        name: 'judge',
        value: result.overall,
        comment: result.scores.map((s) => `${s.dimension}: ${s.score} — ${s.why}`.trim()).join('\n').slice(0, 1000),
        metadata: { systemId: id, judgedBy: user.id, dimensions: result.scores },
      })
    : false;
  return NextResponse.json({ ...result, scored, runId: scored ? runId : undefined });
}, { parse: true, defaultStatus: 500 });
