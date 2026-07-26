/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import type { CurrentUser } from '@/lib/core/auth';
import { requirePrincipal } from '@/lib/data/server';
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
export const POST = withRoute<{ id: string }, { name?: string; type?: string; sql?: string }>(async ({ user, params, body }) => {
  const { id } = params;
  const name = (body.name ?? '').trim();
  if (!name) return NextResponse.json({ error: 'name your measure (e.g. revenue)' }, { status: 400 });
  const type = (MEASURE_TYPES.includes(body.type as MeasureType) ? body.type : 'sum') as MeasureType;
  if (type !== 'count' && !(body.sql ?? '').trim()) {
    return NextResponse.json({ error: `a ${type} measure needs a column` }, { status: 400 });
  }

  const dataset = defineMeasure(id, user, { name, type, sql: (body.sql ?? '').trim() });
  const build = await buildStage(dataset, 'metric', user.id);
  return NextResponse.json({ dataset, build, cube: scaffoldCubeYaml(dataset) });
}, { parse: true, gate: requirePrincipal as () => Promise<CurrentUser> });

export const GET = withRoute<{ id: string }>(async ({ user, params }) => {
  const { id } = params;
  const dataset = getDataset(id, user);
  return NextResponse.json({ measures: dataset.measures, cube: scaffoldCubeYaml(dataset), columns: dataset.columns });
}, { gate: requirePrincipal as () => Promise<CurrentUser> });
