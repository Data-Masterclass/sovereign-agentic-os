/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { config } from '@/lib/config';
import { requireUser } from '@/lib/auth';
import { errorResponse } from '@/lib/data/server';
import { ensureHydrated, listDatasets, type Principal } from '@/lib/data/store';
import { queryRun } from '@/lib/governed';
import {
  assembleCatalog,
  registryAssets,
  type CatalogAsset,
} from '@/lib/data/catalog';
import { openMetadataSource, omEntityUrl } from '@/lib/data/openmetadata';

export const dynamic = 'force-dynamic';

/**
 * Structured-data catalog — an HONEST UNION of what actually exists, labelled by
 * source (registry / Trino / OpenMetadata). It NEVER 500s on a missing warehouse:
 *   • the governed dataset registry is always available (and DLS-scoped to the
 *     caller by the store, so a creator only sees their own + shared datasets);
 *   • Trino tables are listed from the caller's OWN domain schema (schema-agnostic
 *     query-tool), and a missing/empty schema degrades to an honest source status
 *     ("physical marts not materialized yet") instead of a Trino error;
 *   • OpenMetadata is the CORE metadata backbone: a live health probe drives its
 *     CONNECTED state (token or not), the governed marts are deep-linked into it,
 *     and its own tables are pulled to enrich the union when a bot token is set. An
 *     unreachable OM degrades to a calm "reconnecting…" — never a 500, never "off".
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

/** Attach an OpenMetadata entity deep link to each governed Iceberg mart, so every
 *  governed row can jump into the metadata backbone. Non-materialized registry
 *  entries (`registry:<id>`) get no link — omEntityUrl returns null for them. */
function withOmLinks(assets: CatalogAsset[]): CatalogAsset[] {
  return assets.map((a) => {
    const omUrl = omEntityUrl(config.openmetadataUrl, config.openmetadataService, a.fqn);
    return omUrl ? { ...a, omUrl } : a;
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

  // Governed registry marts (DLS-scoped). The materialized ones (real `iceberg.*`
  // FQNs) are what this OS mirrors into OpenMetadata — count them for the OM pill.
  const registry = registryAssets(listDatasets(p));
  const mirroredMarts = registry.filter((a) => a.fqn.startsWith('iceberg.')).length;

  const result = await assembleCatalog({
    schema: principal,
    registry,
    trino: () => fromQueryTool(principal),
    openmetadata: () =>
      openMetadataSource({
        apiUrl: config.openmetadataApiUrl,
        jwt: config.openmetadataJwt || undefined,
        fetchImpl: fetch,
        mirroredMarts,
      }),
  });
  // Deep-link every governed Iceberg asset (registry + Trino) into its OM entity.
  result.assets = withOmLinks(result.assets);
  return NextResponse.json(result);
}
