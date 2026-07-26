/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Kajabi public-API resource map — PURE and client-safe (no secrets, no server
 * imports). Imported by BOTH the server client (`kajabi.ts`) and the SyncPanel,
 * so the UI and the executor agree on one truth about what each resource supports.
 *
 * Kajabi's public API (https://api.kajabi.com/v1, docs at
 * https://help.kajabi.com/api-reference) has NO describe endpoint, so this is a
 * CURATED map of the documented list resources relevant for analytics. Honesty
 * rules (Connector Design Standard §5 — never fake incremental semantics):
 *
 *   • `cursor: 'updated_at'` — the resource documents `sort=updated_at`, so an
 *     incremental sync detects BOTH new and changed records (true incremental).
 *     Only `purchases` qualifies today.
 *   • `cursor: 'created_at'` — the resource documents `sort=created_at` but NO
 *     updated-at sort/filter, so incremental degrades to CREATED-AT-ONLY: new
 *     records append; edits to existing records are NOT picked up (full refresh
 *     to capture edits).
 *   • `cursor: null` — the resource documents no timestamp sort at all (offers
 *     and contact_tags carry no timestamps whatsoever), so the ONLY honest sync
 *     mode is full-refresh.
 *
 * The incremental pull uses DESCENDING-sort stop-early paging (`sort=-<cursor>`,
 * stop at the first row ≤ the watermark) — deliberately NOT the `filter[..._gte]`
 * suffix params, whose exact spelling (`_gte` vs `_gteq`) Kajabi's docs leave
 * ambiguous across resources. Sort keys above are verbatim from each endpoint's
 * documented sort list; nothing here is guessed.
 */

/** The incremental cursor a Kajabi resource honestly supports. */
export type KajabiCursorField = 'updated_at' | 'created_at' | null;

export type KajabiResource = {
  /** The table name shown in discovery / used as `sync.source.table`. */
  name: string;
  /** API path under the base URL (all documented at help.kajabi.com/api-reference). */
  path: string;
  /** The honest incremental cursor (see module doc). */
  cursor: KajabiCursorField;
  /** One honest line on what the resource's sync semantics are. */
  note: string;
};

/**
 * Documented page-size param is `page[size]`; the only documented maximum is 100
 * (contact notes) and no global max is published — 100 is the safe bound.
 */
export const KAJABI_PAGE_SIZE = 100;

export const KAJABI_RESOURCES: KajabiResource[] = [
  { name: 'contacts', path: '/v1/contacts', cursor: 'created_at',
    note: 'New contacts append by created_at; edits are NOT detected (no updated_at sort/filter in the API) — full refresh to capture edits.' },
  { name: 'customers', path: '/v1/customers', cursor: 'created_at',
    note: 'Members/customers. New records append by created_at; edits are NOT detected — full refresh to capture edits.' },
  { name: 'purchases', path: '/v1/purchases', cursor: 'updated_at',
    note: 'Offer purchases — true incremental (sort=updated_at is documented): new AND changed purchases sync.' },
  { name: 'orders', path: '/v1/orders', cursor: 'created_at',
    note: 'New orders append by created_at; later changes (e.g. fulfilled_at) are NOT detected — full refresh to capture them.' },
  { name: 'transactions', path: '/v1/transactions', cursor: null,
    note: 'Payment transactions. The API documents no sort at all — full refresh only (its day-granular start/end date filters are a v2 candidate).' },
  { name: 'offers', path: '/v1/offers', cursor: null,
    note: 'Offers carry no created_at/updated_at in the API — full refresh only (usually a small table).' },
  { name: 'products', path: '/v1/products', cursor: null,
    note: 'Products document no timestamp sort — full refresh only (usually a small table).' },
  { name: 'courses', path: '/v1/courses', cursor: null,
    note: 'Courses document no timestamp sort — full refresh only (usually a small table).' },
  { name: 'forms', path: '/v1/forms', cursor: null,
    note: 'Forms document no timestamp sort — full refresh only (usually a small table).' },
  { name: 'form_submissions', path: '/v1/form_submissions', cursor: 'created_at',
    note: 'sort=created_at is documented; the created_at attribute is only partially documented — if rows arrive without it, the sync fails honestly (use full refresh).' },
  { name: 'contact_tags', path: '/v1/contact_tags', cursor: null,
    note: 'Tags carry no timestamps — full refresh only (a small table).' },
  { name: 'sites', path: '/v1/sites', cursor: null,
    note: 'The account’s sites — full refresh only (a tiny table; also the health-probe read).' },
];

const BY_NAME: Record<string, KajabiResource> = Object.fromEntries(
  KAJABI_RESOURCES.map((r) => [r.name, r]),
);

/** Look up a curated resource by name (case-insensitive). Undefined ⇒ unknown. */
export function kajabiResource(name: string): KajabiResource | undefined {
  return BY_NAME[(name ?? '').trim().toLowerCase()];
}

/** The honest cursor field for a resource (null ⇒ full-refresh only / unknown). */
export function kajabiCursorField(name: string): KajabiCursorField {
  return kajabiResource(name)?.cursor ?? null;
}
