/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Cross-domain Row-Level Security — the compile + evaluate pair behind
 * "import = a governed grant, consumed under the consumer's identity + RLS".
 *
 * PURE logic (testable without a cluster). In a live deployment the *compile*
 * step is what the policy compiler emits to Trino/OPA (`rowFilter`) and Cube
 * (`securityContext` query rewrite) — see data-policy-compiler.md. The *evaluate*
 * step here is the offline-mock stand-in for those engines: it filters the mock
 * preview/sample rows exactly as the engine would filter live rows, so the same
 * grant yields the same rows on both paths.
 *
 * Invariant (data-policy-compiler.md R1/R2): the predicate is bound to the
 * VIEWER's claims, never a service account — so two domains importing the same
 * product see different rows. That divergence is the marketplace's core proof.
 */

import type { RowPredicate, GrantScope, ProductType } from './types';

/**
 * Compile the RLS predicate a viewer-domain gets for a product. The default
 * cross-domain rule scopes a consumer to rows tagged with their own domain — the
 * low-cardinality group encoding Trino requires (R1) and Cube applies via
 * securityContext. A product may instead be `open-rows` (all rows visible to any
 * grantee, e.g. a public reference metric) which compiles to `true`.
 */
export function compileRls(
  viewerDomain: string,
  opts: { rowScope?: 'by-domain' | 'open-rows'; columns?: string[] } = {},
): GrantScope {
  const rowScope = opts.rowScope ?? 'by-domain';
  const rows: RowPredicate = rowScope === 'open-rows' ? 'true' : `domain = '${esc(viewerDomain)}'`;
  return { rows, columns: opts.columns };
}

/** Escape single quotes so a domain value can't break out of the predicate. */
function esc(v: string): string {
  return v.replace(/'/g, "''");
}

/**
 * Evaluate a compiled predicate against a single row (the offline-mock engine).
 * Supports `true` and a conjunction of `field = 'value'` clauses joined by
 * ` AND ` — the exact shape `compileRls` emits. Anything it can't parse fails
 * CLOSED (returns false) so the mock never leaks rows the engine would mask.
 */
export function rowMatches(predicate: RowPredicate, row: Record<string, string>): boolean {
  const p = predicate.trim();
  if (p === '' || p.toLowerCase() === 'true') return true;
  if (p.toLowerCase() === 'false') return false;
  const clauses = p.split(/\s+AND\s+/i);
  for (const clause of clauses) {
    const m = clause.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*'((?:[^']|'')*)'\s*$/);
    if (!m) return false; // unparseable → fail closed
    const field = m[1];
    const value = m[2].replace(/''/g, "'");
    if ((row[field] ?? '') !== value) return false;
  }
  return true;
}

/** Apply a grant scope to a set of rows: RLS row filter + optional column projection. */
export function applyRls(
  scope: GrantScope,
  columns: string[],
  rows: string[][],
): { columns: string[]; rows: string[][] } {
  // Row filter.
  const keptRows = rows.filter((r) => {
    const obj: Record<string, string> = {};
    columns.forEach((c, i) => (obj[c] = r[i] ?? ''));
    return rowMatches(scope.rows, obj);
  });
  // Column projection (if a column allow-list is set).
  if (!scope.columns || scope.columns.length === 0) {
    return { columns, rows: keptRows };
  }
  const keepIdx = columns
    .map((c, i) => (scope.columns!.includes(c) ? i : -1))
    .filter((i) => i >= 0);
  return {
    columns: keepIdx.map((i) => columns[i]),
    rows: keptRows.map((r) => keepIdx.map((i) => r[i] ?? '')),
  };
}

/**
 * The runtime that carries the RLS for a read-in-place product, for display.
 * (Mirrors `enforcementTarget` but phrased for the trust/preview surface.)
 */
export function rlsEngineLabel(type: ProductType): string {
  switch (type) {
    case 'metric':
    case 'dashboard':
      return 'Cube row-level security (per-viewer securityContext)';
    case 'knowledge':
    case 'file':
      return 'OpenSearch Document-Level Security';
    default:
      return 'Trino + OPA row filter';
  }
}
