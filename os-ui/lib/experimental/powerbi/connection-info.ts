/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * The connection details a builder needs to point Power BI at THEIR domain's governed
 * metrics via Cube's Postgres-wire SQL API. Pure logic: given the caller's domain + the
 * operator-configured host/port, it returns the exact `Get Data → PostgreSQL` fields —
 * WITHOUT the password. The password is delivered ONLY through the vault/secret path
 * (never in this JSON, never in the browser); this shape carries a `passwordRef`
 * pointing at that secret, not the value.
 */
import { biUserForDomain, securityContextForDomain, type BiSecurityContext } from './principal.ts';

/** Operator-configured SQL-API exposure (from Helm `cube.sqlApi`). `host` is the
 *  in-cluster Service (`cube-sql`) or the external ingress host the operator published;
 *  `port` is `CUBEJS_PG_SQL_PORT`. `enabled` reflects `cube.sqlApi.enabled`. */
export type SqlApiExposure = {
  enabled: boolean;
  host: string;
  port: number;
  /** Where the domain principal's password lives (vault path / k8s Secret ref). Shown to
   *  the builder as guidance, NEVER the secret itself. */
  passwordSecretName: string;
};

export type PowerBiConnectionInfo = {
  enabled: boolean;
  /** PostgreSQL "Server" field: `host:port`. */
  server: string;
  host: string;
  port: number;
  /** PostgreSQL "Database" field. Power BI passes this through to Cube; we use the domain
   *  BI user's name as the database so a single SQL endpoint disambiguates domains. */
  database: string;
  /** The SQL login (Power BI "User name"). */
  user: string;
  /** The domain this principal is scoped to. */
  domain: string;
  /** How to retrieve the password — a reference, not the value. */
  password: { source: 'vault'; secretName: string; key: string };
  /** The exact governed scope this principal sees (for the UI + doc to render honestly). */
  securityContext: BiSecurityContext;
  /** Honest note surfaced next to the details. */
  scopeNote: string;
};

const DOMAIN_SCOPE_NOTE =
  'Domain-level access: this is a shared, read-only BI principal for the whole domain. ' +
  'Every viewer of a report built on it sees the same domain-scoped rows — it is NOT ' +
  'per-individual row-level security. Per-viewer RLS needs Entra ID → Cube JWT federation ' +
  '(a later phase).';

/**
 * Build the connection info for `domain` against the operator's SQL-API exposure. The
 * caller MUST have already checked the requester belongs to `domain` (the route does
 * this); this function assumes an authorised domain and returns no secret material.
 */
export function connectionInfoForDomain(domain: string, exposure: SqlApiExposure): PowerBiConnectionInfo {
  const user = biUserForDomain(domain);
  return {
    enabled: exposure.enabled,
    server: `${exposure.host}:${exposure.port}`,
    host: exposure.host,
    port: exposure.port,
    // Cube's SQL API ignores the database name for routing, but Power BI requires a
    // non-empty Database field; using the BI user keeps the connection self-describing.
    database: user,
    user,
    domain: securityContextForDomain(domain).domains[0],
    password: { source: 'vault', secretName: exposure.passwordSecretName, key: 'CUBEJS_SQL_PASSWORD' },
    securityContext: securityContextForDomain(domain),
    scopeNote: DOMAIN_SCOPE_NOTE,
  };
}
