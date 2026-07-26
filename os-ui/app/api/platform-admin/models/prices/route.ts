/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { adminCtx, fail } from '../../_ctx';
import { config } from '@/lib/core/config';
import {
  ensureHydrated,
  getStoredPrices,
  setModelPrices,
  type ModelPrice,
} from '@/lib/platform-admin/model-prices';
import { audit } from '@/lib/platform-admin/audit';

export const dynamic = 'force-dynamic';

type PriceRow = ModelPrice & { source: 'stored' | 'env' };

/** Effective view: stored overrides beat the env seed; each row says which won. */
function view(): { prices: Record<string, PriceRow>; updatedAt?: string; updatedBy?: string } {
  const stored = getStoredPrices();
  const prices: Record<string, PriceRow> = {};
  for (const [name, p] of Object.entries(config.modelPrices)) prices[name] = { ...p, source: 'env' };
  for (const [name, p] of Object.entries(stored?.prices ?? {})) prices[name] = { ...p, source: 'stored' };
  return { prices, updatedAt: stored?.updatedAt, updatedBy: stored?.updatedBy };
}

export async function GET() {
  try {
    await adminCtx();
    await ensureHydrated();
    return NextResponse.json(view());
  } catch (e) {
    return fail(e);
  }
}

/**
 * Save per-model token prices (EUR per 1M tokens). Body:
 * `{ prices: { <model_name>: { inputPerM, outputPerM } | null } }` — null clears
 * the override (back to the env seed, else unpriced). Admin-only (adminCtx).
 */
export async function PATCH(req: Request) {
  try {
    const { user, tenant } = await adminCtx();
    await ensureHydrated();
    const body = await req.json();
    const patch = body?.prices;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).length === 0) {
      return NextResponse.json({ error: 'A prices map is required' }, { status: 400 });
    }
    const doc = setModelPrices(patch as Record<string, ModelPrice | null>, user.id);
    audit({
      tenant: tenant.id,
      actor: user.id,
      role: user.role,
      action: 'model.prices',
      target: Object.keys(patch).map((n) => `model:${n}`).join(','),
      detail: `Updated token prices (EUR/1M) for ${Object.keys(patch).join(', ')}; ${Object.keys(doc.prices).length} stored override(s)`,
    });
    return NextResponse.json(view());
  } catch (e) {
    return fail(e);
  }
}
