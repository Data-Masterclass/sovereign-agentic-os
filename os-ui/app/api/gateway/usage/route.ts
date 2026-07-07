/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { config } from '@/lib/config';
import { requireUser } from '@/lib/auth';
import { errorResponse } from '@/lib/data/server';
import { shapeUsage, type RawActivity, type RawSpend } from '@/lib/gateway-usage';

export const dynamic = 'force-dynamic';

/**
 * LLM Gateway usage (read-only, ALL users). Reads LiteLLM's TENANT-aggregate
 * endpoints server-side with the master key (which NEVER leaves this process)
 * and returns a key-free summary: total requests + tokens, total spend, and the
 * budget envelope. No per-user data, no keys — the browser sees only the shaped
 * `usage` object. Requires an OS session (401 for anon).
 */
async function getJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${config.litellmUrl}${path}`, {
      headers: { authorization: `Bearer ${config.litellmMasterKey}`, accept: 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function GET() {
  try {
    await requireUser();
  } catch (e) {
    return errorResponse(e);
  }

  // Tenant totals (requests + tokens) and total spend. Both fail soft to null.
  const activity = await getJson<RawActivity>('/global/activity');
  const spend = await getJson<RawSpend>('/global/spend');

  if (activity == null && spend == null) {
    return NextResponse.json(
      { error: 'Could not reach the LiteLLM gateway for usage.' },
      { status: 502 },
    );
  }

  const usage = shapeUsage({
    activity,
    spend,
    budgetUsd: config.litellmBudgetUsd,
    budgetWindow: config.litellmBudgetWindow,
  });
  return NextResponse.json({ usage });
}
