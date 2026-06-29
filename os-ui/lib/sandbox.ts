/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Personal / sandbox lane logic — DuckDB kept BEHIND Trino's governance boundary.
 *
 * Invariants (stack-decisions.md "DuckDB — personal/sandbox lane"):
 *   1. A user's sandbox only ever sees (a) their own uploads or (b) a
 *      Trino-authorized (already row/column-masked) extract — never a governed
 *      mart directly. `assertSandboxScoped` enforces (b) at the SQL boundary; the
 *      sandbox-duckdb engine has NO Polaris/catalog creds so it can't reach them.
 *   2. Governed data enters the sandbox ONLY via `pullExtract`, which runs the
 *      query THROUGH the governed Trino path (so OPA masking always applies).
 *   3. The ONLY path back to shared is `promotePlan` — dbt-trino writes a governed
 *      Iceberg product + OpenMetadata catalogs it.
 *
 * Pure logic (dependency-injected) so the invariants are unit-tested without a
 * live backend; the API route wires the real governed query path.
 */

export type SandboxOrigin = 'upload' | 'extract';

export interface SandboxDataset {
  id: string;
  name: string;
  origin: SandboxOrigin;
  columns: string[];
  rows: string[][];
}

/** Each user gets a private object-storage prefix — not shared, not a domain product. */
export function privatePrefix(userId: string): string {
  return `s3://sandbox/${userId}/`;
}

export type GovernedQueryFn = (
  sql: string,
  principal: string,
) => Promise<{ engine: string; columns: string[]; rows: string[][] }>;

/**
 * Pull an extract THROUGH Trino (governed). The result is whatever Trino's OPA
 * row/column plugin already masked for `principal`; it lands as a private extract
 * on the user's prefix. This is the only door governed data takes into the sandbox.
 */
export async function pullExtract(opts: {
  principal: string;
  sql: string;
  name: string;
  queryFn: GovernedQueryFn;
}): Promise<SandboxDataset> {
  const r = await opts.queryFn(opts.sql, opts.principal);
  if (r.engine !== 'trino') {
    throw new Error('pull-extract must go through Trino (governed) — refusing an ungoverned read');
  }
  return {
    id: `extract-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: opts.name,
    origin: 'extract',
    columns: r.columns,
    rows: r.rows,
  };
}

// Governed marts live in the Iceberg/Polaris catalog; the sandbox DuckDB must
// never name them. A catalog-qualified reference is the tell.
const GOVERNED_CATALOG_REF = /\b(?:iceberg|polaris|hive)\s*\.\s*\w/i;

/** Reject any sandbox query that reaches into a governed catalog/mart. */
export function assertSandboxScoped(sql: string): void {
  if (GOVERNED_CATALOG_REF.test(sql)) {
    throw new Error(
      'sandbox DuckDB cannot read governed marts — pull an extract through Trino first',
    );
  }
}

export interface PromotePlan {
  engine: 'dbt-trino';
  target: string;
  catalog: 'openmetadata';
  domain: string;
  owner: string;
  visibility: string;
  source: string;
}

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Promote a sandbox dataset into the governed lane — the ONLY sandbox->shared
 * path. dbt-trino writes it as a governed Iceberg product; OpenMetadata catalogs
 * it (owner/domain/visibility/lineage). Production transforms stay dbt-trino.
 */
export function promotePlan(
  d: SandboxDataset,
  meta: { domain: string; owner: string; visibility: string },
): PromotePlan {
  return {
    engine: 'dbt-trino',
    target: `iceberg.${meta.domain}.${slug(d.name)}`,
    catalog: 'openmetadata',
    domain: meta.domain,
    owner: meta.owner,
    visibility: meta.visibility,
    source: d.id,
  };
}
