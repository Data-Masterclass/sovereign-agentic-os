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
 * The governed `predict` door the Science TAB calls (the in-app "Try it" panel).
 * GENERIC: `model` selects any registered model (default: the churn slice). It
 * runs AS THE SIGNED-IN USER — principal `user:<id>` + SESSION domains, never a
 * demo service principal — through the SAME `servePredict` governance both front
 * doors share: tier scope (Personal→Domain→Marketplace) AND the OPA `predict`
 * grant (the model OWNER self-consumes without a third-party grant), then a
 * Langfuse trace. Promoting/certifying the model widens who can call — no
 * separate publish step.
 *
 *   POST { model?, account?, features? }  ->  { decision, score, band, traceId, ... }
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

  // Only the prediction inputs (+ which model) come from the body. Identity
  // (principal + domains) is NEVER client-supplied — it is bound to the SESSION,
  // so a user cannot forge either.
  let body: { model?: string; account?: string; features?: Partial<ChurnFeatures> | Record<string, number> } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body => score the churn model with the default (neutral) features */
  }

  const result = await servePredict({
    model: typeof body.model === 'string' ? body.model : undefined,
    account: body.account,
    features: body.features,
    principal: `user:${user.id}`,
    domains: user.domains,
    isAgent: false,
    requestedBy: user.id,
  });
  return NextResponse.json(result.body, { status: result.status });
}
