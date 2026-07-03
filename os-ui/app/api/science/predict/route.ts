/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { config } from '@/lib/config';
import { servePredict } from '@/lib/science/serve';
import type { ChurnFeatures } from '@/lib/science';

export const dynamic = 'force-dynamic';

/**
 * The deployed churn model as a governed `predict` MCP tool — the AGENT front
 * door (Science golden path §6–7). One of two doors onto the SAME KServe
 * endpoint; the OTHER is the REST API at `./rest`. Both run identical governance
 * via `servePredict`: tier scope (Personal→Domain→Marketplace) AND the OPA
 * `predict` grant, then a Langfuse trace. Promoting/certifying the model widens
 * who can call — no separate publish step.
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
  let body: { account?: string; features?: Partial<ChurnFeatures> } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body => score with the default (neutral) feature vector */
  }

  // The MCP door's caller is the governed agent principal (granted predict); the
  // callable-scope check uses the human caller's own domains from the session.
  const result = await servePredict({
    account: body.account,
    features: body.features,
    principal: 'sales-assistant',
    domains: user.domains,
    isAgent: true,
    requestedBy: user.id,
  });
  return NextResponse.json(result.body, { status: result.status });
}
