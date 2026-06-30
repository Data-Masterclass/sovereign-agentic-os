/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/data/server';
import { getDataset } from '@/lib/data/store';
import { stepperStages } from '@/lib/data/panels';

export const dynamic = 'force-dynamic';

/** One logical dataset, opened as its Bronze→Silver→Gold stepper. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requirePrincipal();
    const { id } = await ctx.params;
    const dataset = getDataset(id, user);
    return NextResponse.json({ dataset, stages: stepperStages(dataset) });
  } catch (e) {
    return errorResponse(e);
  }
}
