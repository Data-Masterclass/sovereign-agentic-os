/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Per-DOMAIN Power BI service principal — the pure logic shared by the Cube SQL-API
 * config (`checkSqlAuth`) and the `/api/powerbi/connection-info` route.
 *
 * WHY per-domain, not per-viewer: Cube's Postgres-wire SQL API authenticates a single
 * `(user, password)` pair per connection. Power BI opens ONE connection with ONE stored
 * credential, so the finest identity a BI report can carry is the SQL USER it logs in as
 * — not the human reading the report. We therefore mint ONE read-only SQL principal per
 * OS domain (`bi_<domain>`). Cube's `checkSqlAuth` parses the domain back out of that
 * username and returns the SAME `securityContext` shape the governed HTTP path uses
 * (governed.ts RLS_STRUCTURAL_KEYS: sub/domains/role/scope), so the SQL query flows
 * Cube → Trino → OPA filtered to exactly that domain's rows.
 *
 * HONEST SCOPE: this is DOMAIN-level RLS. Every viewer of a given Power BI report shares
 * the domain principal and therefore sees the same domain-scoped rows. Per-INDIVIDUAL
 * RLS (region/team filters per human) needs Entra ID → Cube JWT federation (each viewer's
 * own token → securityContext) and is a later phase — see docs/powerbi-consumption.md.
 *
 * This module is pure + dependency-free so it runs in tests and in the Cube `cube.js`
 * config (which is plain Node) unchanged.
 */

/** A domain id is the OS tenant scope (lowercase slug). We normalise to the same charset
 *  Postgres/Power BI accept unquoted in a username. */
export function normalizeDomainId(domain: string): string {
  return String(domain || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** The fixed prefix every BI SQL principal carries. Keeps them recognisable in Cube
 *  logs + Trino OPA audit, and lets `checkSqlAuth` reject any non-BI SQL login fast. */
export const BI_USER_PREFIX = 'bi_';

/** The read-only BI SQL username for a domain, e.g. `sales` → `bi_sales`. This is the
 *  `database`/user Power BI logs in as. Throws on an empty/invalid domain so we never
 *  mint a principal that resolves to an empty securityContext. */
export function biUserForDomain(domain: string): string {
  const d = normalizeDomainId(domain);
  if (!d) throw new Error('powerbi: empty/invalid domain id');
  return `${BI_USER_PREFIX}${d}`;
}

/** Recover the domain id from a BI SQL username, or null if it isn't a BI principal. */
export function domainFromBiUser(user: string): string | null {
  const u = String(user || '').trim().toLowerCase();
  if (!u.startsWith(BI_USER_PREFIX)) return null;
  const d = normalizeDomainId(u.slice(BI_USER_PREFIX.length));
  return d || null;
}

/**
 * The Cube `securityContext` for a domain BI principal. Structural keys mirror the
 * governed HTTP path (governed.ts): `sub` identifies the principal for audit,
 * `domains` drives Cube's queryRewrite → Trino/OPA RLS, `role` is the LOWEST role
 * (creator — a BI reader never promotes/approves), and `scope` tags it read-only so a
 * future policy can distinguish BI traffic. No region/team attribute is set → this is
 * domain-level scope, not per-viewer.
 */
export type BiSecurityContext = {
  sub: string;
  domains: string[];
  role: 'creator';
  scope: 'bi-readonly';
};

export function securityContextForDomain(domain: string): BiSecurityContext {
  const d = normalizeDomainId(domain);
  if (!d) throw new Error('powerbi: empty/invalid domain id');
  return { sub: `bi:${d}`, domains: [d], role: 'creator', scope: 'bi-readonly' };
}

/**
 * Resolve a SQL login (the username Power BI connects as) to its domain securityContext,
 * or null if it isn't a recognised BI principal. This is the exact function Cube's
 * `checkSqlAuth` calls: given the SQL `user`, return the securityContext to attach to
 * every query on that connection. Password verification is separate (Cube compares the
 * presented password to `CUBEJS_SQL_PASSWORD`); this only maps user → domain scope.
 */
export function resolveSqlPrincipal(sqlUser: string): BiSecurityContext | null {
  const domain = domainFromBiUser(sqlUser);
  if (!domain) return null;
  return securityContextForDomain(domain);
}
