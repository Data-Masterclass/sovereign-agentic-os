/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/core/auth';
import type { Connection } from '@/lib/connections/schema';
import { config } from '@/lib/core/config';
import { getSecretServerSide } from '@/lib/infra/secrets';
import { listConnectionsForUser, getConnectionForUser } from '@/lib/connections/store';
import {
  type OmConn,
  type OmRead,
  type OmDomain,
  type OmDataProduct,
  detectOmVersion,
  listOmDomains,
  listOmDataProducts,
  listOmTables,
  searchOmCatalog,
  getOmLineage,
} from '@/lib/data/openmetadata';
import type { CatalogAsset, SourceSeverity } from '@/lib/data/catalog';

/**
 * External-OpenMetadata reads, per-connection (Phase 1 — read / discover only).
 *
 * This is the SERVER-SIDE bridge between an `om-catalog` {@link Connection} and
 * the pure per-connection OM client (`lib/data/openmetadata`). It resolves the
 * connection under the caller's identity (so DLS applies — a user never touches a
 * connection they can't see), reads the bot JWT from the vault (server-side only,
 * never returned/logged), and exposes the five read tools + a catalog-discovery
 * fold. There is NO write path here — Phase 1 never POSTs/PUTs/PATCHes OM.
 */

/** Build the pure OM client config from a resolved `om-catalog` connection. The
 *  bot JWT is dereferenced from the vault HERE and never leaves the server. */
function omConnFrom(c: Connection): OmConn {
  const token = getSecretServerSide(c.secretRef) ?? undefined;
  return { baseUrl: c.endpoint, token, fetchImpl: fetch, timeoutMs: 2500 };
}

/** The FIRST `om-catalog` connection the caller may see (their own personal one,
 *  or a shared one in their domain). Null when none is connected/visible — the
 *  discovery fold then contributes nothing (nothing changes when OM is off). */
export async function firstOmCatalogFor(user: CurrentUser): Promise<Connection | null> {
  if (!config.openmetadataConnectEnabled) return null;
  const conns = await listConnectionsForUser(user);
  return conns.find((c) => c.template === 'om-catalog') ?? null;
}

/** Resolve a specific `om-catalog` connection the caller may see (id from the UI/
 *  MCP). Throws 404 for an unseeable id (no existence leak); 400 for wrong type. */
export async function resolveOmCatalog(connId: string, user: CurrentUser): Promise<Connection> {
  const c = await getConnectionForUser(connId, user); // DLS guard (404)
  if (c.template !== 'om-catalog') {
    const e = new Error('Not an OpenMetadata (om-catalog) connection') as Error & { status?: number };
    e.status = 400;
    throw e;
  }
  return c;
}

// --------------------------------------------------------- per-tool reads (MCP) --

export function omListDomains(c: Connection): Promise<OmRead<OmDomain[]>> {
  return listOmDomains(omConnFrom(c));
}
export function omListDataProducts(c: Connection): Promise<OmRead<OmDataProduct[]>> {
  return listOmDataProducts(omConnFrom(c));
}
export function omListTables(c: Connection): Promise<OmRead<CatalogAsset[]>> {
  return listOmTables(omConnFrom(c));
}
export function omSearch(c: Connection, query: string): Promise<OmRead<CatalogAsset[]>> {
  return searchOmCatalog(omConnFrom(c), query);
}
export function omLineage(c: Connection, fqn: string, entity?: string): Promise<OmRead<unknown>> {
  return getOmLineage(omConnFrom(c), fqn, entity);
}
export function omVersion(c: Connection): Promise<string | undefined> {
  return detectOmVersion(omConnFrom(c));
}

// ---------------------------------------------------- catalog discovery fold ----

/** The shape the catalog assembler's optional `omConnection` source consumes. */
export type OmConnectionSource = {
  assets: CatalogAsset[] | null;
  status: string;
  severity?: SourceSeverity;
  ok?: boolean;
  count?: number;
};

/**
 * Fold an external OM's domains / data products / tables into the catalog union
 * as DLS-scoped discovery context. `visibleFqns` is the set of Iceberg FQNs the
 * caller may already see (from the registry/Trino sources) — OM tables are
 * CLAMPED to that set so the raw bot-token view is NEVER exposed to every user.
 * OM domains + data products are a discovery SIGNAL (counted in the status), not
 * an authorization boundary, so they are summarised rather than dumped as rows.
 *
 * Never throws: an unreachable/absent OM degrades to a calm source status.
 */
export async function omConnectionSource(
  c: Connection | null,
  visibleFqns: Set<string>,
): Promise<OmConnectionSource | null> {
  if (!c) return null; // no external OM connected/visible → the source is absent

  const conn = omConnFrom(c);
  const [domains, products, tables] = await Promise.all([
    listOmDomains(conn),
    listOmDataProducts(conn),
    listOmTables(conn),
  ]);

  // Unreachable (every read failed with the network reason) → calm reconnecting.
  const allUnreachable =
    !domains.ok && !products.ok && !tables.ok &&
    domains.reason === 'unreachable';
  if (allUnreachable) {
    return {
      assets: null,
      ok: false,
      count: 0,
      status: `reconnecting to external catalog "${c.name}"…`,
      severity: 'warn',
    };
  }

  // DLS clamp: only surface OM tables whose FQN maps to something the caller may
  // already see. OM Trino FQNs are `<service>.<icebergFqn>`; strip an optional
  // leading service segment so `<service>.iceberg.<schema>.<table>` matches the
  // caller's own `iceberg.<schema>.<table>` entitlement. Never widen the view.
  const omTables = tables.ok ? tables.data : [];
  const clamped: CatalogAsset[] = omTables
    .map((t) => {
      const fqn = t.fqn;
      const idx = fqn.indexOf('iceberg.');
      const icebergFqn = idx >= 0 ? fqn.slice(idx) : fqn;
      return { ...t, source: 'om-connection' as const, fqn: icebergFqn };
    })
    .filter((t) => visibleFqns.has(t.fqn));

  const domainCount = domains.ok ? domains.data.length : 0;
  const productCount = products.ok ? products.data.length : 0;
  const bits = [
    `${clamped.length} discoverable table${clamped.length === 1 ? '' : 's'}`,
    `${domainCount} domain${domainCount === 1 ? '' : 's'}`,
    `${productCount} data product${productCount === 1 ? '' : 's'}`,
  ];
  return {
    assets: clamped.length ? clamped : null,
    ok: true,
    count: clamped.length,
    status: `external catalog "${c.name}" · ${bits.join(' · ')} (DLS-scoped)`,
    severity: 'ok',
  };
}
