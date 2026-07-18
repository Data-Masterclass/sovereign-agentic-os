/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { biUserForDomain } from '../powerbi/principal.ts';

/**
 * The Superset DATABASE descriptor for a domain's Cube SQL API connection — the fix for
 * the empty-chart symptom (#142/#155). A dashboard chart's dataset is a Cube VIEW, and
 * those views are served ONLY by Cube's Postgres-wire SQL API (`cube-sql:15432`), NOT by
 * Trino's `iceberg` catalog. So the Superset database must be a `postgresql://` connection
 * to Cube SQL, authenticated as the domain's read-only BI principal (`bi_<domain>`) — the
 * SAME principal Power BI uses (lib/powerbi/principal.ts). Cube's `checkSqlAuth` maps that
 * username → domain securityContext → Trino/OPA row filtering, so governance is preserved
 * at the connection principal; the per-viewer Superset guest-token RLS clause still applies
 * on top (embed.ts), keeping both governance layers intact.
 *
 * PURE: the password is NEVER embedded here. The URI carries a placeholder token; the
 * server-only import client (superset/client.ts) substitutes the real secret into the
 * Superset import `passwords` map at POST time, so this module stays secret-free + testable
 * and no credential ever reaches the browser or a stored artifact.
 */

/** Placeholder the URI carries in place of the Cube SQL password. The server-only import
 *  client swaps this for the real secret via the import `passwords` map (never inline). */
export const CUBE_SQL_PASSWORD_PLACEHOLDER = '__CUBE_SQL_PASSWORD__';

/** The Superset service/connection name for a domain's Cube SQL database. Distinct per
 *  domain so two domains' dashboards don't collide on one connection (#155). */
export function cubeDatabaseName(domain: string): string {
  return `cube_${biUserForDomain(domain).replace(/^bi_/, '')}`;
}

export type CubeSqlDatabase = {
  /** Superset `database_name` + the manifest's `database_service_name`. */
  service_name: string;
  /** The SQLAlchemy URI — `postgresql://bi_<domain>:<placeholder>@<host>:<port>/<db>`. */
  sqlalchemy_uri: string;
  /** Marker so the import client knows to inject the real Cube SQL password for this db. */
  cube_sql: true;
};

/** Build the Cube SQL database descriptor for `domain`. Host/port default to the in-cluster
 *  Service; an operator override (CUBE_SQL_HOST/PORT) is threaded in by the caller. */
export function cubeSqlDatabase(
  domain: string,
  opts: { host?: string; port?: number } = {},
): CubeSqlDatabase {
  const user = biUserForDomain(domain); // throws on an empty/invalid domain
  const host = opts.host || 'cube-sql';
  const port = opts.port || 15432;
  // Cube ignores the database name for routing, but Postgres requires a non-empty db —
  // using the BI user keeps the connection self-describing (mirrors powerbi/connection-info).
  return {
    service_name: cubeDatabaseName(domain),
    sqlalchemy_uri: `postgresql://${user}:${CUBE_SQL_PASSWORD_PLACEHOLDER}@${host}:${port}/${user}`,
    cube_sql: true,
  };
}
