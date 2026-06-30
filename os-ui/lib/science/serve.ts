/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { trace } from '@/lib/agent-governed';
import { authorizePredict } from './model-service.ts';
import { predictTool, CHURN, DEFAULT_FEATURES, type ChurnFeatures } from './churn.ts';

/**
 * The governed `predict` service body, shared by BOTH front doors:
 *   • REST API  (Software apps / external) — `app/api/science/predict/rest`
 *   • MCP tool  (agents)                   — `app/api/science/predict`
 *
 * Both run the SAME governance — `authorizePredict` (tier scope + OPA tool grant)
 * then a Langfuse trace — so the two doors can never diverge. The ONLY difference
 * is `isAgent` (which door) and the default principal; the decision, the score,
 * and the audit are identical. This is the model-as-service guarantee.
 */

export type ServeResult = {
  status: number;
  body: Record<string, unknown>;
};

export async function servePredict(opts: {
  account?: string;
  features?: Partial<ChurnFeatures>;
  principal: string;
  domain: string;
  isAgent: boolean;
  requestedBy?: string;
}): Promise<ServeResult> {
  const account = (opts.account ?? '').toString();
  const features: ChurnFeatures = { ...DEFAULT_FEATURES, ...(opts.features ?? {}) } as ChurnFeatures;
  const caller = { principal: opts.principal, domain: opts.domain, isAgent: opts.isAgent };

  const authz = await authorizePredict(CHURN.model, caller);
  const common = {
    tool: 'predict',
    model: CHURN.model,
    principal: opts.principal,
    frontDoor: authz.frontDoor,
    tier: authz.policy.tier,
    policy: authz.toolPolicy,
    decision: authz.decision,
    reason: authz.reason,
  };

  if (authz.decision === 'deny') {
    const tr = await trace({ principal: opts.principal, tool: 'predict', input: { account, frontDoor: authz.frontDoor }, output: { denied: authz.reason }, decision: 'deny' });
    return { status: 403, body: { ...common, traceId: tr.id } };
  }
  if (authz.decision === 'requires_approval') {
    const tr = await trace({ principal: opts.principal, tool: 'predict', input: { account, frontDoor: authz.frontDoor }, output: { held: authz.reason }, decision: 'requires_approval' });
    return { status: 202, body: { ...common, traceId: tr.id } };
  }

  // allow → run the model + trace the prediction.
  const r = await predictTool(account, features);
  const tr = await trace({
    principal: opts.principal,
    tool: 'predict',
    input: { account, model: CHURN.model, frontDoor: authz.frontDoor, features },
    output: { score: r.score, band: r.band, source: r.source },
    decision: 'allow',
    costUsd: 0.0002,
  });
  return {
    status: 200,
    body: { ...common, requestedBy: opts.requestedBy, traceId: tr.id, ...r },
  };
}
