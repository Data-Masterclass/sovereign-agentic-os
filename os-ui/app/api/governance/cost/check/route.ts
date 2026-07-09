/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { currentUser } from '@/lib/core/auth';
import { addSpend, checkCap, type CapScope } from '@/lib/governance/cost';

export const dynamic = 'force-dynamic';

/**
 * The enforcement seam (§4): a metered action asks here before running. An
 * over-cap action is BLOCKED (403). Demonstrates that setting a cap actually
 * constrains spend, without needing live LiteLLM. `commit` records the spend
 * when allowed (so repeated calls eventually breach the cap).
 */
export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  let body: { scope?: CapScope; subject?: string; amount?: number; modelClass?: string; commit?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const scope = (['key', 'domain', 'tenant'].includes(String(body?.scope)) ? body.scope : 'domain') as CapScope;
  const subject = String(body?.subject ?? '').trim();
  const amount = Number(body?.amount ?? 0);
  if (!subject || !Number.isFinite(amount)) {
    return NextResponse.json({ error: 'subject + numeric amount required' }, { status: 400 });
  }
  const result = checkCap({ scope, subject, amount, modelClass: body?.modelClass });
  if (!result.allowed) {
    return NextResponse.json(result, { status: 403 });
  }
  if (body?.commit) addSpend(scope, subject, amount, body?.modelClass);
  return NextResponse.json(result);
}
