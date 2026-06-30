/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/data/server';
import { importProduct } from '@/lib/data/store';
import { runConformance } from '@/lib/data/policy/conformance';
import { buildRoster } from '@/lib/data/build/live-clients';

export const dynamic = 'force-dynamic';

/**
 * Import / subscribe to a marketplace data product from another domain. Records the
 * importing domain + adds the read grant the policy compiler turns into OPA/Cube
 * access. A grant change re-runs the CONFORMANCE check (OPA path == Cube path) so the
 * new import is enforced identically on both paths before the importer queries it.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requirePrincipal();
    const { id } = await ctx.params;
    const product = importProduct(id, user);
    const conformance = runConformance([product], await buildRoster());
    return NextResponse.json({ dataset: product, conformance });
  } catch (e) {
    return errorResponse(e);
  }
}
