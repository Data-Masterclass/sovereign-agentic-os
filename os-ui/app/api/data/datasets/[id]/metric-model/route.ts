/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import type { CurrentUser } from '@/lib/core/auth';
import { requirePrincipal } from '@/lib/experimental/data/server';
import { getDataset } from '@/lib/experimental/data/store';
import { scaffoldMetricYaml } from '@/lib/experimental/data/metrics';

export const dynamic = 'force-dynamic';

/**
 * The dataset's NATIVE metric model: the OS's own YAML definition generated from the
 * governed Gold mart (its columns become the dimensions; the declared measures become
 * the measures). This is the definition the metric path compiles to governed Trino SQL
 * — there is no external semantic-layer service to query. Read-only; the dataset load
 * is the view-scope guard, so an unseeable id is a typed not-found.
 */
export const GET = withRoute<{ id: string }>(async ({ user, params }) => {
  const dataset = getDataset(params.id, user);
  return NextResponse.json({
    measures: dataset.measures,
    columns: dataset.columns,
    model: scaffoldMetricYaml(dataset),
  });
}, { gate: requirePrincipal as () => Promise<CurrentUser> });
