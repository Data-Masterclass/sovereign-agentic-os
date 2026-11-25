/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The guards a compiled os-data bundle must pass before OPA may receive it.
 * USER STORY: As a user I want a store that loaded only partly, or an os-ui pod that is behind, to
 *             never shrink what OPA knows about me; as an admin I want a real large removal to go
 *             through only when I have acknowledged it.
 * ARCHITECTURE:
 *   - Pure. The baseline is the last good bundle os-ui served, or (after an os-ui restart) the
 *     documents OPA has active, read from OPA itself.
 *   - Refused, unless acknowledged: fewer governance tables than the baseline; an internal-catalog
 *     table of the baseline missing (trino.rego gives such a table no row filter or mask); a
 *     relative drop above `maxDropPercent` in grant principals, governance principals or tables.
 *   - OPA itself activates an empty or an older bundle without complaint (no monotonic revision),
 *     which is why these checks live here.
 *   - `diffStats` names WHAT a refused compile would remove or add (grant principal ids, governance
 *     principal ids, table names), bounded to `DIFF_LIST_LIMIT` per list with the full totals, so
 *     the admin acknowledges a list and not only a count. Ids only — no personal data.
 */

export type BundleStats = {
  grants: number;
  principals: number;
  tables: string[];
  /** The grant principal ids (sorted). Absent on a stats object built before ids were kept. */
  grantIds?: string[];
  /** The governance principal ids (sorted). */
  principalIds?: string[];
};

/** Catalogs whose tables are the OS's own lakehouse (trino.rego `internal_catalogs`). */
export const INTERNAL_CATALOGS = ['iceberg'];

export function statsOf(data: Record<string, unknown>): BundleStats {
  const keys = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v) : []);
  const gov = (data.governance ?? {}) as Record<string, unknown>;
  const grantIds = keys(data.grants).sort();
  const principalIds = keys(gov.principals).sort();
  return { grants: grantIds.length, principals: principalIds.length, tables: keys(gov.tables).sort(), grantIds, principalIds };
}

/** The longest list of removed or added items kept per category; the totals stay exact. */
export const DIFF_LIST_LIMIT = 200;

/** What one category loses and gains, bounded to `limit` items each, with the exact totals. */
export type ListDiff = { removed: string[]; added: string[]; removedTotal: number; addedTotal: number };
export type BundleDiff = { grantPrincipals: ListDiff; governancePrincipals: ListDiff; tables: ListDiff };

function listDiff(next: string[] | undefined, base: string[] | undefined, limit: number): ListDiff {
  const n = new Set(next ?? []);
  const b = new Set(base ?? []);
  const removed = [...b].filter((x) => !n.has(x)).sort();
  const added = [...n].filter((x) => !b.has(x)).sort();
  return { removed: removed.slice(0, limit), added: added.slice(0, limit), removedTotal: removed.length, addedTotal: added.length };
}

/**
 * Exactly which ids `next` removes from and adds to `base`. Null without a baseline, or when the
 * baseline holds no ids (then only counts are known, and the reasons say so).
 */
export function diffStats(next: BundleStats, base: BundleStats | null, limit = DIFF_LIST_LIMIT): BundleDiff | null {
  if (!base || !base.grantIds || !base.principalIds) return null;
  return {
    grantPrincipals: listDiff(next.grantIds, base.grantIds, limit),
    governancePrincipals: listDiff(next.principalIds, base.principalIds, limit),
    tables: listDiff(next.tables, base.tables, limit),
  };
}

function dropPct(base: number, now: number): number {
  return base > 0 ? ((base - now) / base) * 100 : 0;
}

/** Every reason `next` must not replace `base`; empty when it may. */
export function guardReasons(next: BundleStats, base: BundleStats | null, maxDropPercent: number): string[] {
  const out: string[] = [];
  if (next.grants === 0) out.push('the compiled grants document is empty');
  if (next.principals === 0) out.push('the compiled governance principals are empty');
  if (!base) return out;
  if (next.tables.length < base.tables.length) out.push(`fewer governance tables than the last good bundle (${next.tables.length} < ${base.tables.length})`);
  const have = new Set(next.tables);
  const missing = base.tables.filter((t) => INTERNAL_CATALOGS.includes(t.split('.')[0]) && !have.has(t));
  if (missing.length) out.push(`internal table(s) missing from governance: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ` (+${missing.length - 5})` : ''}`);
  for (const [what, b, n] of [
    ['grant principals', base.grants, next.grants],
    ['governance principals', base.principals, next.principals],
    ['governance tables', base.tables.length, next.tables.length],
  ] as const) {
    const d = dropPct(b, n);
    if (d > maxDropPercent) out.push(`${what} drop ${d.toFixed(1)} % (${b} → ${n}), above ${maxDropPercent} %`);
  }
  return out;
}

/** `<seq>-<hash>`: the os-data revision. Returns the seq, or null for any other shape. */
export function revisionSeq(revision: string | null | undefined): number | null {
  const m = /^"?(\d+)-[0-9a-f]+"?$/.exec((revision ?? '').trim());
  return m ? Number(m[1]) : null;
}
