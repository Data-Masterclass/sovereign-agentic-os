/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { config } from '@/lib/config';
import { trace } from '@/lib/agent-governed';
import {
  proposePlan,
  authorizeAgentStep,
  assertAgentCannotCertify,
  type AgentMode,
  type SafetyPreset,
  type PlanStep,
} from '@/lib/science';

export const dynamic = 'force-dynamic';

/**
 * The ML agent (guided AutoML) under TWO-MODE governance (Science golden path §4).
 * Returns a proposed plan (explore → features → train → register → deploy-to-
 * Staging) with EACH step's governance decision under the chosen mode:
 *   • in-tab     → writes/GPU need inline approval (human present);
 *   • autonomous → bounded by safety presets + GPU quota.
 *
 * It also proves the invariant: a `certify` / go-live step is ALWAYS blocked for
 * the agent (the plan never proposes one; a forged one is rejected here). The
 * agent proposes; a human Builder/Admin ships.
 *
 *   POST { goal?, mode, preset?, gpuQuota? } -> { plan, steps[], certifyAttempt }
 */
export async function POST(req: Request) {
  if (!config.mlEnabled) {
    return NextResponse.json({ error: 'Science (Layer 4) is off' }, { status: 404 });
  }
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 401 });
  }

  let body: { goal?: string; mode?: AgentMode; preset?: SafetyPreset; gpuQuota?: number } = {};
  try {
    body = await req.json();
  } catch {
    /* defaults below */
  }
  const goal = (body.goal ?? 'build a churn model from the sales data').toString();
  const mode: AgentMode = body.mode === 'autonomous' ? 'autonomous' : 'in-tab';
  const preset: SafetyPreset = body.preset === 'bounded-writes' ? 'bounded-writes' : 'read-propose';
  const gpuQuotaRemaining = Number.isFinite(body.gpuQuota) ? Number(body.gpuQuota) : 0;

  const plan = proposePlan(goal);
  const steps = plan.steps.map((s) => ({
    ...s,
    decision: authorizeAgentStep(s, { mode, preset, gpuQuotaRemaining }),
  }));

  // Prove the agent cannot self-certify: a forged certify step is rejected.
  let certifyAttempt: { blocked: boolean; reason: string };
  const forged: PlanStep = { key: 'certify', label: 'certify + go-live to Production', kind: 'certify', adapter: 'governance' };
  try {
    assertAgentCannotCertify(forged);
    certifyAttempt = { blocked: false, reason: 'UNEXPECTED — agent was allowed to certify' };
  } catch (e) {
    certifyAttempt = { blocked: true, reason: (e as Error).message };
  }

  await trace({
    principal: 'ml-agent',
    tool: 'ml_agent_plan',
    input: { goal, mode, preset },
    output: { steps: steps.map((s) => ({ key: s.key, decision: s.decision.decision })), certifyBlocked: certifyAttempt.blocked },
    decision: 'allow',
  });

  return NextResponse.json({ requestedBy: user.id, goal, mode, preset, gpuQuotaRemaining, steps, certifyAttempt });
}
