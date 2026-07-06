/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/data/server';
import { getDataset, addCheck } from '@/lib/data/store';

export const dynamic = 'force-dynamic';

/**
 * Data-quality check intentions for a dataset.
 *
 * GET  — returns the list of checks the caller may see (canView gate via getDataset).
 * POST — appends a new check (canEdit gate via addCheck: owner or domain Admin).
 *
 * Checks are RECORDED here alongside dataset.yaml — they are NOT auto-executed by
 * the OS. Connect a data quality tool (dbt tests, Great Expectations, Soda, …) to
 * run them and push results back. This is surfaced honestly in the detail view.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requirePrincipal();
    const { id } = await ctx.params;
    const dataset = getDataset(id, user);
    return NextResponse.json({ checks: dataset.checks ?? [] });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requirePrincipal();
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as { name?: string; description?: string };
    if (!body.name?.trim()) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }
    const dataset = addCheck(id, user, {
      name: body.name,
      description: body.description ?? '',
    });
    const check = (dataset.checks ?? []).at(-1)!;
    return NextResponse.json({ check, checksCount: (dataset.checks ?? []).length });
  } catch (e) {
    return errorResponse(e);
  }
}
