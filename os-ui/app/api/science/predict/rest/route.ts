/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { config } from '@/lib/core/config';
import { servePredict } from '@/lib/science/serve';
import type { ChurnFeatures } from '@/lib/science';

export const dynamic = 'force-dynamic';

/**
 * The deployed churn model as a governed REST `predict` API — the SOFTWARE /
 * EXTERNAL front door (Science golden path §6–7). The "Churn Risk" app/dashboard
 * calls this to score accounts and write them back. It is the SECOND door onto
 * the SAME KServe endpoint (the first is the MCP tool at `..`) and runs the
 * IDENTICAL governance through `servePredict` — tier scope + OPA `predict` grant
 * + Langfuse trace — so a Software app and an agent can never get different
 * answers or different policy. Same model, same governance, two front doors.
 *
 *   POST { account?, features?, principal? }  ->  { decision, score, band, traceId, ... }
 */
export async function POST(req: Request) {
  if (!config.mlEnabled) {
    return NextResponse.json({ error: 'Science (Layer 4) is off — set ml.enabled=true to enable the predict service' }, { status: 404 });
  }
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 401 });
  }

  // Only the prediction inputs come from the body. Identity (principal + domain)
  // is NEVER client-supplied — it is bound to the fixed front-door service
  // principal and the caller's SESSION domains, so a user cannot forge either.
  let body: { model?: string; account?: string; features?: Partial<ChurnFeatures> | Record<string, number> } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body => score with the default (neutral) feature vector */
  }

  // The REST door's caller is the Churn Risk software app (granted predict); the
  // callable-scope check uses the human caller's own domains from the session.
  // `model` selects any registered model (default: the churn slice).
  const result = await servePredict({
    model: typeof body.model === 'string' ? body.model : undefined,
    account: body.account,
    features: body.features,
    principal: 'churn-risk-app',
    domains: user.domains,
    isAgent: false,
    requestedBy: user.id,
  });
  return NextResponse.json(result.body, { status: result.status });
}
