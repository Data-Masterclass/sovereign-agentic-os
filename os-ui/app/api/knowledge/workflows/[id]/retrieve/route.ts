/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { getWorkflow, getDomainKnowledge } from '@/lib/knowledge/store';
import { chunkWorkflow, chunkDomain } from '@/lib/knowledge/chunk';
import { indexWorkflow, indexDomain } from '@/lib/knowledge/index-pipeline';
import { hasWorkflowUnits } from '@/lib/knowledge/index-store';
import { retrieveKnowledge } from '@/lib/knowledge/retrieve';
import { buildContextPack } from '@/lib/knowledge/context-pack';
import { traceContext } from '@/lib/knowledge/knowledge-trace';

export const dynamic = 'force-dynamic';

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

type Params = { params: Promise<{ id: string }> };

/**
 * POST { query } → the governed context pack for this workflow:
 *   • PINNED: the domain card + the workflow's structured steps + its HARD rules.
 *   • RETRIEVED: OPA-gated, DLS-filtered, reranked top-k tail (tacit, soft rules…).
 * Traces pinned-vs-retrieved to Langfuse. A non-granted principal is DENIED (the
 * retrieval is blocked) — the gate the validation step exercises.
 */
export async function POST(req: Request, { params }: Params) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const query = typeof body.query === 'string' ? body.query.trim() : '';
    if (!query) return NextResponse.json({ error: 'A query is required' }, { status: 400 });

    const view = getWorkflow(id, user);
    const dk = getDomainKnowledge(view.domain);

    // Ensure THIS workflow (+ its domain) is indexed before we retrieve its tail.
    // Gating on a global count skipped indexing for every draft after the first,
    // silently emptying their retrieved tail; gate per-workflow instead
    // (idempotent, incremental — upsert replaces the scope's units).
    if (!hasWorkflowUnits(id)) {
      await indexWorkflow(view.workflow, { owner: view.owner, tacit: view.tacit, updatedAt: view.updatedAt });
      await indexDomain(dk);
    }

    const principal = { id: user.id, domains: user.domains, role: user.role };

    // RETRIEVED tail (OPA gate + DLS filter + rerank inside).
    const result = await retrieveKnowledge(query, principal, { workflowId: id, k: 6 });

    // PINNED: domain card + workflow steps + HARD rules (verbatim).
    const domainUnits = chunkDomain(dk);
    const wfUnits = chunkWorkflow({ workflow: view.workflow, owner: view.owner, tacit: view.tacit, updatedAt: view.updatedAt });
    const workflowSteps = wfUnits.filter((u) => u.provenance.type === 'workflow');
    const hardRuleIds = new Set([
      ...view.workflow.rules.filter((r) => r.hard).map((r) => r.id),
      ...view.workflow.steps.flatMap((s) => s.rules.filter((r) => r.hard).map((r) => r.id)),
    ]);
    const hardRules = wfUnits.filter((u) => u.provenance.type === 'rule' && hardRuleIds.has(u.id.split(':rule:')[1] ?? ''));

    const pack = buildContextPack({
      domainCard: domainUnits,
      workflowSteps,
      hardRules,
      retrieved: result.hits,
      budget: 2000,
    });

    // Trace what entered the window: pinned vs retrieved.
    const trace = await traceContext({
      principal: user.id,
      query,
      workflowId: id,
      pinned: pack.items.filter((i) => i.source === 'pinned').map((i) => ({ id: i.id, kind: i.kind, title: i.title })),
      retrieved: result.hits.map((h) => ({ id: h.unit.id, title: h.unit.title, score: Number(h.score.toFixed(4)) })),
      dropped: pack.dropped.length,
      totalTokens: pack.totalTokens,
      budget: pack.budget,
      decision: result.decision,
      policy: result.policy,
      embedSource: result.embedSource,
      store: result.store,
    });

    return NextResponse.json({
      decision: result.decision,
      policy: result.policy,
      reason: result.reason,
      store: result.store,
      mode: result.mode,
      embedSource: result.embedSource,
      pack: {
        items: pack.items,
        pinnedTokens: pack.pinnedTokens,
        retrievedTokens: pack.retrievedTokens,
        totalTokens: pack.totalTokens,
        budget: pack.budget,
        dropped: pack.dropped.length,
      },
      citations: result.hits.map((h) => ({
        id: h.unit.id,
        title: h.unit.title,
        type: h.unit.provenance.type,
        score: Number(h.score.toFixed(4)),
        trust: h.unit.provenance.trust,
      })),
      trace: { id: trace.id, landed: trace.landed },
    });
  } catch (e) {
    return fail(e);
  }
}
