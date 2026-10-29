/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@core/kernel/auth';
import { errorResponse } from '@tabs/data/lib/server';
import { ensureHydrated, listDatasets, type Principal } from '@tabs/data/lib/store';
import { queryRun } from '@core/infra/governed';
import {
  assembleCatalog,
  registryAssets,
  type CatalogAsset,
} from '@tabs/data/lib/catalog';

export const dynamic = 'force-dynamic';

/**
 * Structured-data catalog — an HONEST UNION of what actually exists, labelled by
 * source (registry / Trino). The OS registry is the system of record for the
 * catalog; there is no external catalog to mirror into. It NEVER 500s on a
 * missing warehouse:
 *   • the governed dataset registry is always available (and DLS-scoped to the
 *     caller by the store, so a creator only sees their own + shared datasets);
 *   • Trino tables are listed from the caller's OWN domain schema (schema-agnostic
 *     query-tool), and a missing/empty schema degrades to an honest source status
 *     ("physical marts not materialized yet") instead of a Trino error.
 * The assembly itself lives in the pure lib/data/catalog module (unit-tested).
 */

/** Physical Iceberg tables in the caller's own domain schema (Trino via query-tool). */
async function fromQueryTool(principal: string): Promise<CatalogAsset[]> {
  // Forward the principal (Trino's OPA plugin scopes the listing to the caller) AND
  // the caller's domain as the session schema, so we list the RIGHT catalog.schema
  // instead of a dead literal. `show tables` is unqualified → resolves in `principal`.
  const data = await queryRun('show tables', principal, principal);
  return data.rows.map((r) => {
    const name = String(r[0]);
    return {
      name,
      fqn: `iceberg.${principal}.${name}`,
      description: '',
      type: 'iceberg table',
      source: 'trino' as const,
    };
  });
}

export async function GET() {
  let user;
  try {
    user = await requireUser();
    // Hydrate the dataset cache from the durable mirror before listing (same as the
    // Data-tab server boundary), so a restarted os-ui still catalogues its datasets.
    await ensureHydrated();
  } catch (e) {
    return errorResponse(e);
  }
  const principal = user.domains[0] ?? user.id;
  const p: Principal = { id: user.id, domains: user.domains, role: user.role };

  // Governed registry marts (DLS-scoped).
  const registry = registryAssets(listDatasets(p));

  const result = await assembleCatalog({
    schema: principal,
    registry,
    trino: () => fromQueryTool(principal),
  });
  return NextResponse.json(result);
}
