/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import type { CurrentUser } from '@core/kernel/auth';
import { requirePrincipal } from '@tabs/data/lib/server';
import { getDataset } from '@tabs/data/lib/store';
import { datasetLineage } from '@tabs/data/lib/lineage-server';

export const dynamic = 'force-dynamic';

/** End-to-end lineage (refinement + consumption + trust) + transparency-gate status.
 *  With DATA_PROJECT_GIT on the edges come from dbt (through Dagster's asset graph); otherwise, and
 *  whenever Dagster cannot answer, from the OS registry — the payload's `source` says which. */
export const GET = withRoute<{ id: string }>(async ({ user, params }) => {
  const { id } = params;
  return NextResponse.json(await datasetLineage(getDataset(id, user)));
}, { gate: requirePrincipal as () => Promise<CurrentUser> });
