/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { authorize, trace } from '@/lib/agent-governed';
import { CHURN, ACME_FEATURES, predictTool, type ChurnFeatures } from '@/lib/science';

export const dynamic = 'force-dynamic';

/**
 * The deployed churn model as a GOVERNED `predict` MCP tool (Science golden path
 * §6–7). A deployed model is governed exactly like any other agent tool: every
 * call is OPA-authorized (allow / deny / requires_approval) and Langfuse-traced
 * over the SAME spine the Sales Assistant uses for `metrics`/`retrieve`. The
 * actual scoring runs against the KServe InferenceService when present and falls
 * back to the deterministic seed when Layer-4 is off (`ml.enabled=false`).
 *
 *   POST { account?, features? }  ->  { decision, score, band, traceId, ... }
 */
export async function POST(req: Request) {
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: (e as { status?: number }).status ?? 401 },
    );
  }

  let body: { account?: string; features?: Partial<ChurnFeatures>; principal?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body => score the reference ACME account */
  }

  const account = (body.account ?? 'ACME').toString();
  // Merge any supplied features over the reference seed (online features would
  // come from Featureform/Valkey in-cluster; here we accept overrides or seed).
  const features: ChurnFeatures = { ...ACME_FEATURES, ...(body.features ?? {}) } as ChurnFeatures;

  // The agent identity that owns the model-as-tool. Defaults to the Sales
  // Assistant which is granted `predict`; an explicit principal is honoured.
  const principal = (body.principal ?? 'sales-assistant').toString();
  const authz = await authorize(principal, 'predict');

  if (authz.effect === 'deny') {
    const tr = await trace({
      principal,
      tool: 'predict',
      input: { account, features },
      output: { denied: authz.reason },
      decision: 'deny',
    });
    return NextResponse.json(
      { tool: 'predict', principal, decision: 'deny', policy: authz.policy, reason: authz.reason, traceId: tr.id },
      { status: 403 },
    );
  }

  if (authz.effect === 'requires_approval') {
    const tr = await trace({
      principal,
      tool: 'predict',
      input: { account, features },
      output: { held: authz.reason },
      decision: 'requires_approval',
    });
    return NextResponse.json(
      { tool: 'predict', principal, decision: 'requires_approval', policy: authz.policy, reason: authz.reason, traceId: tr.id },
      { status: 202 },
    );
  }

  // allow -> run the model and trace the prediction.
  try {
    const r = await predictTool(account, features);
    const tr = await trace({
      principal,
      tool: 'predict',
      input: { account, model: CHURN.model, features },
      output: { score: r.score, band: r.band, source: r.source },
      decision: 'allow',
      costUsd: 0.0002,
    });
    return NextResponse.json({
      tool: 'predict',
      principal,
      model: CHURN.model,
      requestedBy: user.id,
      decision: 'allow',
      policy: authz.policy,
      traceId: tr.id,
      ...r,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
