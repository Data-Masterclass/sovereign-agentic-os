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

  let body: { account?: string; features?: Partial<ChurnFeatures>; principal?: string; domain?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body => score with the default (neutral) feature vector */
  }

  // The REST door's caller is a SOFTWARE app (defaults to the Churn Risk app, granted predict).
  const result = await servePredict({
    account: body.account,
    features: body.features,
    principal: (body.principal ?? 'churn-risk-app').toString(),
    domain: (body.domain ?? 'sales').toString(),
    isAgent: false,
    requestedBy: user.id,
  });
  return NextResponse.json(result.body, { status: result.status });
}
