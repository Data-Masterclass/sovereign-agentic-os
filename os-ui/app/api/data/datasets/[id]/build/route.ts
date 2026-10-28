/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import type { CurrentUser } from '@/lib/core/auth';
import { requirePrincipal } from '@/lib/experimental/data/server';
import { getDataset } from '@/lib/experimental/data/store';
import { buildStage } from '@/lib/experimental/data/build/server';
import type { DataStage } from '@/lib/experimental/data/build/adapter';

export const dynamic = 'force-dynamic';

const STAGES: DataStage[] = ['bronze', 'silver', 'gold', 'promote', 'certify'];

/**
 * Run a stage's Build (execute → verify) for a dataset: dlt (Bronze) → dbt/Trino
 * (Silver, Gold) → Polaris/Iceberg publish (`promote`/`certify`), whose **policy**
 * adapter compiles one source into the OPA rules Trino enforces and then verifies the
 * governed read path actually honours them (else ✗). There is no metric/dashboard/catalog
 * stage: metrics and dashboards are defined in their own tabs on the built Gold mart.
 * Live when the stack is reachable, else the honest offline-mock.
 */
export const POST = withRoute<{ id: string }, { stage?: DataStage }>(async ({ user, params, body }) => {
  const { id } = params;
  if (!body.stage || !STAGES.includes(body.stage)) {
    return NextResponse.json({ error: `stage must be one of ${STAGES.join('|')}` }, { status: 400 });
  }
  const dataset = getDataset(id, user); // view-scope guard
  const build = await buildStage(dataset, body.stage, user.id);
  return NextResponse.json({ build });
}, { parse: true, gate: requirePrincipal as () => Promise<CurrentUser> });
