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
  type SourceSeverity,
} from '@/lib/data/catalog';

export const dynamic = 'force-dynamic';

/**
 * Structured-data catalog — an HONEST UNION of what actually exists, labelled by
 * source (registry / Trino / OpenMetadata). It NEVER 500s on a missing warehouse:
 *   • the governed dataset registry is always available (and DLS-scoped to the
 *     caller by the store, so a creator only sees their own + shared datasets);
 *   • Trino tables are listed from the caller's OWN domain schema (schema-agnostic
 *     query-tool), and a missing/empty schema degrades to an honest source status
 *     ("physical marts not materialized yet") instead of a Trino error;
 *   • OpenMetadata is included only WITH a bot token — no token means it is skipped
 *     honestly rather than firing a doomed 401 and silently falling back.
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

/** OpenMetadata catalog entries — ONLY when a bot token is configured. When it is not,
 *  that is an OPTIONAL integration left un-configured (calm `info`), not a fault; a real
 *  reachability/auth failure is a `warn`. */
async function fromOpenMetadata(): Promise<{ assets: CatalogAsset[] | null; status: string; severity?: SourceSeverity }> {
  if (!config.openmetadataJwt) {
    return { assets: null, status: 'optional catalog integration — not connected', severity: 'info' };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  try {
    const res = await fetch(
      `${config.openmetadataApiUrl}/api/v1/tables?limit=50&fields=description`,
      {
        cache: 'no-store',
        signal: ctrl.signal,
        headers: { accept: 'application/json', authorization: `Bearer ${config.openmetadataJwt}` },
      },
    );
    if (!res.ok) return { assets: null, status: `OpenMetadata ${res.status} — dropped from the union`, severity: 'warn' };
    const data = (await res.json()) as { data?: Record<string, unknown>[] };
    if (!Array.isArray(data?.data)) return { assets: null, status: 'OpenMetadata returned no table list', severity: 'warn' };
    const assets: CatalogAsset[] = data.data.map((t) => ({
      name: String(t.name ?? ''),
      fqn: String(t.fullyQualifiedName ?? t.name ?? ''),
      description: String(t.description ?? ''),
      type: 'table',
      source: 'openmetadata',
    }));
    return { assets, status: 'OpenMetadata catalog' };
  } catch {
    return { assets: null, status: 'OpenMetadata unreachable — dropped from the union', severity: 'warn' };
  } finally {
    clearTimeout(timer);
  }
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

  const result = await assembleCatalog({
    schema: principal,
    registry: registryAssets(listDatasets(p)),
    trino: () => fromQueryTool(principal),
    openmetadata: () => fromOpenMetadata(),
  });
  return NextResponse.json(result);
}
