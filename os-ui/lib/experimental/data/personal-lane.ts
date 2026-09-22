/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * The PERSONAL lane — a user's own datasets, kept BEHIND Trino's governance.
 *
 * SINGLE-ENGINE INVARIANT (data-architecture-model.md, single-engine cleanup):
 * there is NO separate personal query engine. A user's own data lives as a physical
 * Iceberg table in their private schema (`iceberg.personal_<uid>.*`) and is queried
 * THROUGH the SAME governed Trino path (`queryRun`, owner-principal) as every other
 * read — so OPA row/column masking always applies and there is one place a query can
 * run. (The old `sandbox-duckdb` engine that used to answer personal queries is gone.)
 *
 * This module keeps ONLY the still-needed pure helpers:
 *   - `privatePrefix`      — the user's object-storage upload prefix (MinIO).
 *   - `pullExtract`        — pull a Trino-authorized, already-masked extract.
 *   - `assertScopedToSelf` — reject a personal query that reaches a governed catalog.
 *   - `promotePlan`        — the ONLY personal→shared path (dbt-trino → Iceberg + OM).
 *
 * Pure (dependency-injected) so the invariants are unit-tested without a live backend;
 * the API route wires the real governed query path.
 */

export type PersonalOrigin = 'upload' | 'extract';

export interface PersonalDataset {
  id: string;
  name: string;
  origin: PersonalOrigin;
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
 * on the user's prefix. This is the only door governed data takes into the personal
 * lane — and, since the query lane is now Trino too, the same governed engine.
 */
export async function pullExtract(opts: {
  principal: string;
  sql: string;
  name: string;
  queryFn: GovernedQueryFn;
}): Promise<PersonalDataset> {
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

// Governed marts live in the Iceberg/Polaris catalog; a personal-lane query names
// only the user's OWN tables. A catalog-qualified reference to a governed catalog is
// the tell — such a read must go through the governed domain principal, not the
// personal lane. (Kept as a defence-in-depth guard on the pull-extract source SQL.)
const GOVERNED_CATALOG_REF = /\b(?:iceberg|polaris|hive)\s*\.\s*\w/i;

/** Reject any personal-lane query that reaches into a governed catalog/mart. */
export function assertScopedToSelf(sql: string): void {
  if (GOVERNED_CATALOG_REF.test(sql)) {
    throw new Error(
      'a personal-lane query cannot read governed marts — pull an extract through Trino first',
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
 * Promote a personal dataset into the governed lane — the ONLY personal→shared
 * path. dbt-trino writes it as a governed Iceberg product; OpenMetadata catalogs
 * it (owner/domain/visibility/lineage). Production transforms stay dbt-trino.
 */
export function promotePlan(
  d: PersonalDataset,
  meta: { domain: string; owner: string; visibility: string },
): PromotePlan {
  return {
    engine: 'dbt-trino',
    // Normalize the domain to a valid Trino identifier (dash→underscore) — the SAME
    // shape as store-fqn.domainSchema — so a hyphenated domain (`agentic-leader-q3-2026`)
    // targets the real Iceberg schema (`agentic_leader_q3_2026`) instead of a SYNTAX_ERROR.
    target: `iceberg.${slug(meta.domain)}.${slug(d.name)}`,
    catalog: 'openmetadata',
    domain: meta.domain,
    owner: meta.owner,
    visibility: meta.visibility,
    source: d.id,
  };
}
