/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { getSystem } from '@/lib/agents/store';
import { assistantComplete } from '@/lib/assistant/complete';
import { judgeRun, type JudgeComplete } from '@/lib/agents/evaluate-judge';
import { getWorkflow } from '@/lib/knowledge/store';
import type { CurrentUser } from '@/lib/core/auth';
import type { System } from '@/lib/agents/system-schema';

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

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
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
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as {
      output?: string;
      description?: string;
      tacitKnowledge?: string;
    };

    // Edit-scope: getSystem enforces read access (owner / in-domain); reuse its view.
    const view = getSystem(id, user);

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

    // Route the judge through the ONE governed assistant model (Langfuse-audited).
    const complete: JudgeComplete = (messages) =>
      assistantComplete(messages, { user: user.id }).then((r) => r.content);

    const result = await judgeRun({ output, description, tacitKnowledge }, complete);
    return NextResponse.json(result);
  } catch (e) {
    return fail(e);
  }
}
