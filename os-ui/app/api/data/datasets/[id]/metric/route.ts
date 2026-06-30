/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/data/server';
import { defineMeasure, getDataset } from '@/lib/data/store';
import { MEASURE_TYPES, scaffoldCubeYaml, type MeasureType } from '@/lib/data/metrics';
import { buildStage } from '@/lib/data/build/server';

export const dynamic = 'force-dynamic';

/**
 * Define a metric on the Gold version (the Cube handover). The user only NAMES the
 * measure (+ picks the aggregation/column); `cube_dbt` scaffolds the dimensions. We
 * then run the Metric stage's Build (cube → om) — LIVE if Cube is reachable, else the
 * honest offline-mock — and return the ✓/✗ rows. GET returns the generated cube preview.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requirePrincipal();
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as { name?: string; type?: string; sql?: string };
    const name = (body.name ?? '').trim();
    if (!name) return NextResponse.json({ error: 'name your measure (e.g. revenue)' }, { status: 400 });
    const type = (MEASURE_TYPES.includes(body.type as MeasureType) ? body.type : 'sum') as MeasureType;
    if (type !== 'count' && !(body.sql ?? '').trim()) {
      return NextResponse.json({ error: `a ${type} measure needs a column` }, { status: 400 });
    }

    const dataset = defineMeasure(id, user, { name, type, sql: (body.sql ?? '').trim() });
    const build = await buildStage(dataset, 'metric', user.id);
    return NextResponse.json({ dataset, build, cube: scaffoldCubeYaml(dataset) });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requirePrincipal();
    const { id } = await ctx.params;
    const dataset = getDataset(id, user);
    return NextResponse.json({ measures: dataset.measures, cube: scaffoldCubeYaml(dataset), columns: dataset.columns });
  } catch (e) {
    return errorResponse(e);
  }
}
