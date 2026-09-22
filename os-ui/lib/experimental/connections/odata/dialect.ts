/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * PURE, client-safe OData V2/V4 DIALECT objects (operational-system-connections.md,
 * Phase 4). The two protocol versions differ in a handful of wire details the page
 * puller must get exactly right; encoding them as data (one object per version) keeps
 * the client + sync code version-agnostic — it asks the dialect, never branches inline.
 * No secrets, no I/O — heavily unit-testable.
 *
 * The differences that matter for a bounded, honest slice pull:
 *   • COUNT param — V2 `$inlinecount=allpages` (count rides the page as `__count`);
 *     V4 `$count=true` (count rides the page as `@odata.count`).
 *   • NEXT-LINK — V2 server-driven paging returns `d.__next` (an absolute/relative URL);
 *     V4 returns `@odata.nextLink`. Both are FOLLOWED verbatim (never reconstructed) so
 *     the server's own skiptoken/paging contract is honored.
 *   • ROWS envelope — V2 wraps rows in `d.results` (server paging) or `d` (a plain array);
 *     V4 puts them in `value`.
 *   • DATE literal — a `$filter gt <datetime>` needs the version's literal form: V2
 *     `datetime'2026-01-01T00:00:00'` (or `datetimeoffset'…'`); V4 a BARE ISO literal
 *     `2026-01-01T00:00:00Z`. Built via toISOString so the alphabet is fixed — nothing
 *     smuggled reaches the query.
 */

export type ODataDialect = {
  version: 'V2' | 'V4';
  /** The query param that asks the server to inline the total count. */
  countParam: () => { key: string; value: string };
  /** Read the server's next-page link out of a parsed page body (null when the last page). */
  nextLink: (page: Record<string, unknown>) => string | null;
  /** Extract the row array out of a parsed page body (always an array; [] when absent). */
  rows: (page: Record<string, unknown>) => Record<string, unknown>[];
  /** Read the inlined total count out of a parsed page body (null when the server omitted it). */
  count: (page: Record<string, unknown>) => number | null;
  /** Build the `$filter` datetime literal for a cursor comparison. `edmType` is the
   *  property's EDM type (Edm.DateTimeOffset vs Edm.DateTime) so V2 picks the right prefix. */
  dateLiteral: (iso: string, edmType: string) => string;
};

/** Normalize an incoming value to a strict ISO-8601 UTC string (fixed alphabet). Throws
 *  on a non-datetime so a bad watermark fails honestly rather than smuggling text. */
function toIso(value: string): string {
  const t = Date.parse(String(value ?? '').trim());
  if (Number.isNaN(t)) {
    throw Object.assign(new Error(`odata: '${value}' is not a datetime`), { status: 400 });
  }
  return new Date(t).toISOString();
}

const V2: ODataDialect = {
  version: 'V2',
  countParam: () => ({ key: '$inlinecount', value: 'allpages' }),
  nextLink: (page) => {
    const d = (page as { d?: unknown }).d;
    if (d && typeof d === 'object' && '__next' in (d as Record<string, unknown>)) {
      const n = (d as Record<string, unknown>).__next;
      return typeof n === 'string' && n.trim() ? n : null;
    }
    return null;
  },
  rows: (page) => {
    const d = (page as { d?: unknown }).d;
    if (Array.isArray(d)) return d as Record<string, unknown>[];
    if (d && typeof d === 'object') {
      const results = (d as { results?: unknown }).results;
      if (Array.isArray(results)) return results as Record<string, unknown>[];
    }
    return [];
  },
  count: (page) => {
    const d = (page as { d?: unknown }).d;
    if (d && typeof d === 'object') {
      const c = Number((d as { __count?: unknown }).__count);
      if (Number.isFinite(c)) return c;
    }
    return null;
  },
  dateLiteral: (iso, edmType) => {
    const v = toIso(iso);
    // V2 OData datetime literals: `datetimeoffset'…'` for offset types, else `datetime'…'`.
    // The offset form carries the trailing Z; the plain form drops it (V2 datetime is
    // zone-less). Both are quoted literals — the value alphabet is fixed by toISOString.
    if (edmType.trim().toLowerCase() === 'edm.datetimeoffset') {
      return `datetimeoffset'${v}'`;
    }
    return `datetime'${v.replace(/Z$/, '')}'`;
  },
};

const V4: ODataDialect = {
  version: 'V4',
  countParam: () => ({ key: '$count', value: 'true' }),
  nextLink: (page) => {
    const n = (page as Record<string, unknown>)['@odata.nextLink'];
    return typeof n === 'string' && n.trim() ? n : null;
  },
  rows: (page) => {
    const v = (page as { value?: unknown }).value;
    return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
  },
  count: (page) => {
    const c = Number((page as Record<string, unknown>)['@odata.count']);
    return Number.isFinite(c) ? c : null;
  },
  // V4 uses BARE (unquoted) date/datetime literals in $filter. Fixed alphabet via toIso.
  dateLiteral: (iso) => toIso(iso),
};

/** The dialect for an OData version. */
export function dialectFor(version: 'V2' | 'V4'): ODataDialect {
  return version === 'V2' ? V2 : V4;
}
