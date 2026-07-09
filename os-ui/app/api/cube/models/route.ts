/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { config } from '@/lib/core/config';
import { ensureHydrated, listGovernedDatasets } from '@/lib/data/store';
import { buildCubeModels } from '@/lib/data/cube-models';

export const dynamic = 'force-dynamic';

/**
 * Cube model auto-delivery (data-tab-plan §C T7). Returns, for EVERY governed
 * (shared asset / certified product) dataset, its `cube_dbt` model YAML + the
 * compiled Cube access policy (from the SAME `policy/compiler` source that feeds
 * Trino OPA, so the two can't drift). The Cube model-sync sidecar polls this and
 * writes the changed YAML into Cube's model dir.
 *
 * TRUST BOUNDARY (mirrors the query-tool's `app.py` docstring): this endpoint is
 * CLUSTER-INTERNAL — consumed only by the in-namespace sidecar over the ClusterIP
 * Service, never the browser. It is safe without a user session because it emits
 * ONLY governed tiers: a private `dataset` (owner-only personal lane) is never
 * returned (`listGovernedDatasets` drops it), and the payload carries model
 * DEFINITIONS + access policies — schema and governance metadata — never any row
 * data. Governance itself is enforced downstream (Trino OPA row/column masks on
 * every read; Cube member_level excludes on restricted columns), from this same
 * compiled source. No secrets are exposed. There is deliberately no `POST`.
 */
export async function GET() {
  // Hydrate the registry from the durable mirror once, so a restarted os-ui serves
  // the persisted datasets to the sidecar (idempotent, graceful when OpenSearch off).
  await ensureHydrated();
  const payload = buildCubeModels(listGovernedDatasets(), {
    embedAccessPolicy: config.cubeEmbedAccessPolicy,
  });
  return NextResponse.json(payload, { headers: { 'cache-control': 'no-store' } });
}
