/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/core/auth';
import type { Connection } from '@/lib/connections/schema';
import { getSecretServerSide, isEgressAllowed } from '@/lib/infra/secrets';
import { serviceBearerHeader } from '@/lib/infra/service-bearer';
import { deleteBatchSql, type SyncTarget } from '@/lib/data/sync-sql';
import type { ExecuteIdentity } from '@/lib/infra/governed';
import { config } from '@/lib/core/config';
import {
  KAJABI_PAGE_SIZE,
  kajabiResource,
  type KajabiCursorField,
} from './kajabi-resources';

/**
 * Kajabi REST client — the per-connection bridge to a customer's Kajabi account.
 *
 * HAND-BUILT (Connector Design Standard §4): Kajabi has no Trino connector, and its
 * hosted MCP is per-user interactive OAuth — not a headless server-to-server pull
 * with pagination/cursor control, which is what a scheduled sync needs. So this is
 * a small typed REST client in the Salesforce/Airflow mold: the PURE client part
 * (`fetch` injected, credential injected as ARGS, never logged/returned, never
 * throws — `{ ok:false, reason }`) plus a thin SERVER-SIDE bridge that resolves the
 * connection under the caller's identity (DLS) and dereferences the vaulted secret
 * HERE (it never leaves the server).
 *
 * AUTH: OAuth 2.0 **client-credentials** against the public API
 * (`POST /v1/oauth/token`, form-encoded — Kajabi's preferred grant; docs:
 * help.kajabi.com/api-reference/authentication). Credentials are created in Kajabi
 * under **Settings → Public API** (Owner/Subowner only; Pro plan or the API
 * add-on). The ONE vaulted credential is `<client_id>:<client_secret>` (split on
 * the first `:` server-side), so the generic wizard needs no bespoke fields.
 *
 * SYNC (the API-BATCH executor strategy): responses are JSON:API
 * (`data[].attributes` + `relationships`), paginated with `page[number]`/
 * `page[size]` and `links.next`. An incremental slice uses DESCENDING-sort
 * stop-early paging: probe the max cursor (`sort=-<cursor>&page[size]=1`), then
 * pull `sort=-<cursor>` pages and stop at the first row ≤ the watermark, keeping
 * rows in `(watermark, highWatermark]`. Each page is flattened (attributes +
 * to-one relationship ids) and streamed to the data-runner's `/ingest-rows`
 * (PyIceberg append) — bounded memory, one page in flight.
 *
 * HONEST LIMITS (v1): only `purchases` has a true update cursor (`updated_at`);
 * contacts/customers/orders/form_submissions are CREATED-AT-ONLY incremental (new
 * records append, edits are not detected); every other resource is full-refresh
 * only — see `kajabi-resources.ts`. DELETES are never detected. Kajabi publishes
 * NO rate-limit contract (429s are surfaced honestly and retried next run).
 * To-many relationships (tags, products, …) are skipped, not faked; nested
 * attribute objects are stringified as JSON. Multi-site accounts sync ALL sites'
 * records — the to-one `site` relationship lands as a `site_id` column to filter on.
 */

/** Injectable fetch — the global `fetch` in prod, a fake in tests. */
export type KjFetch = typeof fetch;

/** A per-connection Kajabi client config. The secret fields never leave the
 *  server and are used ONLY to mint an access token. */
export type KajabiConn = {
  /** API base URL, https://api.kajabi.com (no trailing slash; paths carry /v1). */
  baseUrl: string;
  clientId?: string;
  clientSecret?: string;
  fetchImpl: KjFetch;
  timeoutMs?: number;
};

/** A Kajabi read that never throws: data, or an honest failure reason. */
export type KjRead<T> = { ok: true; data: T } | { ok: false; reason: string };

/** One JSON:API record as Kajabi returns it. */
export type KajabiRecord = {
  id?: string;
  type?: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, { data?: { id?: string } | { id?: string }[] | null }>;
};

/** One page of a JSON:API list response. */
export type KajabiPage = {
  data?: KajabiRecord[];
  links?: { next?: string | null };
};

/** Split the ONE vaulted credential `<client_id>:<client_secret>` on the FIRST
 *  colon. Null on a malformed credential — surfaced honestly at call time. */
export function splitKajabiCredential(raw: string | null | undefined): { clientId: string; clientSecret: string } | null {
  const s = (raw ?? '').trim();
  const i = s.indexOf(':');
  if (i <= 0 || i === s.length - 1) return null;
  return { clientId: s.slice(0, i), clientSecret: s.slice(i + 1) };
}

/** Resolve a resource name against the CURATED map (the only names that reach a
 *  URL — nothing user-typed is folded into a path). Throws 400 on an unknown one. */
export function safeKajabiResource(name: string): { name: string; path: string; cursor: KajabiCursorField } {
  const r = kajabiResource(name);
  if (!r) {
    throw Object.assign(
      new Error(`kajabi: unknown resource '${name ?? ''}' — discovery lists the supported ones`),
      { status: 400 },
    );
  }
  return r;
}

/** Normalize a watermark / probed max into the fixed ISO-Z alphabet (built via
 *  toISOString — nothing string-smuggled reaches a query string). */
export function kajabiDatetime(value: string): string {
  const t = Date.parse((value ?? '').trim());
  if (Number.isNaN(t)) {
    throw Object.assign(new Error(`kajabi: '${value}' is not a datetime`), { status: 400 });
  }
  return new Date(t).toISOString();
}

/**
 * Flatten one JSON:API record into a flat row for `/ingest-rows`:
 *   • `id` + every attribute (nested objects/arrays honestly stringified as JSON);
 *   • each TO-ONE relationship as `<name>_id` (e.g. site → site_id);
 *   • TO-MANY relationships are SKIPPED (not representable as flat columns — the
 *     related resource is its own sync), never faked.
 */
export function flattenKajabiRecord(rec: KajabiRecord): Record<string, unknown> {
  const row: Record<string, unknown> = { id: rec.id ?? null };
  for (const [k, v] of Object.entries(rec.attributes ?? {})) {
    row[k] = v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
  }
  for (const [name, rel] of Object.entries(rec.relationships ?? {})) {
    const data = rel?.data;
    if (Array.isArray(data)) continue; // to-many: skipped honestly
    const key = `${name}_id`;
    if (!(key in row)) row[key] = data?.id ?? null;
  }
  return row;
}

function base(conn: KajabiConn): string {
  return conn.baseUrl.replace(/\/$/, '');
}

async function withTimeout(conn: KajabiConn, url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), conn.timeoutMs ?? 30000);
  try {
    return await conn.fetchImpl(url, { ...init, signal: ctrl.signal, cache: 'no-store' });
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------- pure client ------

/** Mint an access token via the client-credentials grant. The secret is used ONLY
 *  to build the form body; it is never returned (only the token is) or logged. */
export async function kjToken(conn: KajabiConn): Promise<KjRead<string>> {
  if (!conn.clientId || !conn.clientSecret) {
    return { ok: false, reason: 'credential must be <client_id>:<client_secret> (Kajabi Settings → Public API key)' };
  }
  try {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: conn.clientId,
      client_secret: conn.clientSecret,
    });
    const res = await withTimeout(conn, `${base(conn)}/v1/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString(),
    });
    const data = (await res.json().catch(() => ({}))) as { access_token?: string; error_description?: string; error?: string };
    if (!res.ok || !data.access_token) {
      return { ok: false, reason: `Kajabi token ${res.status}: ${data.error_description ?? data.error ?? 'no access_token'}` };
    }
    return { ok: true, data: data.access_token };
  } catch {
    return { ok: false, reason: 'Kajabi unreachable' };
  }
}

async function kjGet<T>(conn: KajabiConn, token: string, path: string): Promise<KjRead<T>> {
  try {
    const res = await withTimeout(conn, `${base(conn)}${path}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    if (res.status === 429) {
      // Kajabi publishes no rate-limit contract — surface the honest state; the
      // sync executor's next scheduled run re-covers the slice (cursor discipline).
      return { ok: false, reason: `Kajabi rate-limited; retry after ${res.headers.get('retry-after') ?? '?'}s` };
    }
    const text = await res.text();
    if (!res.ok) return { ok: false, reason: `Kajabi ${res.status}: ${text.slice(0, 240)}` };
    return { ok: true, data: JSON.parse(text) as T };
  } catch {
    return { ok: false, reason: 'Kajabi unreachable' };
  }
}

/** Fetch one list page: `page[number]`/`page[size]`, optional `sort`. */
export function kjListPage(
  conn: KajabiConn,
  token: string,
  path: string,
  args: { page: number; size: number; sort?: string },
): Promise<KjRead<KajabiPage>> {
  const q = new URLSearchParams({ 'page[number]': String(args.page), 'page[size]': String(args.size) });
  if (args.sort) q.set('sort', args.sort);
  return kjGet<KajabiPage>(conn, token, `${path}?${q.toString()}`);
}

/** Probe the resource's max cursor value — `sort=-<cursor>&page[size]=1`, the
 *  cheapest documented probe (there is no MAX() endpoint). Null ⇒ empty resource. */
export async function kjProbeMaxCursor(
  conn: KajabiConn,
  token: string,
  path: string,
  cursorField: string,
): Promise<KjRead<string | null>> {
  const page = await kjListPage(conn, token, path, { page: 1, size: 1, sort: `-${cursorField}` });
  if (!page.ok) return page;
  const first = page.data.data?.[0];
  if (!first) return { ok: true, data: null };
  const raw = first.attributes?.[cursorField];
  if (typeof raw !== 'string' || raw === '') {
    return { ok: false, reason: `kajabi: resource rows do not carry '${cursorField}' — use full-refresh` };
  }
  return { ok: true, data: raw };
}

/**
 * Pull one slice PAGE-BY-PAGE, invoking `onBatch(rows)` with FLATTENED rows for
 * every API page. Bounded memory: exactly one page is held at a time. Returns the
 * total row count, or the honest failure (rows already delivered to `onBatch`
 * stay delivered — at-least-once).
 *
 * With a cursor: descending-sort stop-early paging — keep rows in
 * `(watermark, highWatermark]`, STOP at the first row ≤ the watermark (everything
 * after it is older). Without a cursor (full refresh): plain page walk.
 */
export async function pullKajabiSlice(args: {
  conn: KajabiConn;
  token: string;
  resource: string;
  /** Null ⇒ cursorless full pull (no sort, no windowing). */
  cursorField: string | null;
  /** Exclusive lower bound (null ⇒ everything up to the high watermark). */
  watermark: string | null;
  /** Inclusive upper bound — the probed high watermark (ignored when cursorless). */
  highWatermark: string | null;
  onBatch: (rows: Record<string, unknown>[]) => Promise<void>;
}): Promise<KjRead<number>> {
  const r = safeKajabiResource(args.resource);
  const lower = args.watermark === null ? null : Date.parse(kajabiDatetime(args.watermark));
  const upper = args.highWatermark === null ? null : Date.parse(kajabiDatetime(args.highWatermark));
  let total = 0;
  // Defensive bound: pages are ≤100 records; this only stops a broken paginator
  // that loops, never a real slice (the CronJob's activeDeadline also bounds it).
  for (let pageNo = 1; pageNo <= 10000; pageNo++) {
    const page = await kjListPage(args.conn, args.token, r.path, {
      page: pageNo,
      size: KAJABI_PAGE_SIZE,
      ...(args.cursorField ? { sort: `-${args.cursorField}` } : {}),
    });
    if (!page.ok) return page;
    const records = page.data.data ?? [];
    const rows: Record<string, unknown>[] = [];
    let stop = false;
    for (const rec of records) {
      if (args.cursorField) {
        const raw = rec.attributes?.[args.cursorField];
        const t = typeof raw === 'string' ? Date.parse(raw) : NaN;
        if (Number.isNaN(t)) {
          return { ok: false, reason: `kajabi: a '${r.name}' row has no parseable '${args.cursorField}' — use full-refresh` };
        }
        if (lower !== null && t <= lower) { stop = true; break; } // sorted desc ⇒ the rest is older
        if (upper !== null && t > upper) continue; // created/updated during the pull — next slice's business
      }
      rows.push(flattenKajabiRecord(rec));
    }
    if (rows.length > 0) {
      await args.onBatch(rows);
      total += rows.length;
    }
    if (stop || records.length === 0 || !page.data.links?.next) return { ok: true, data: total };
  }
  return { ok: false, reason: 'Kajabi pagination did not terminate (links.next loop)' };
}

// ---------------------------------------------------------- server bridge -------

/** Build the client config from a Connection RECORD (health probe path). The vault
 *  secret is dereferenced HERE and never leaves the server. */
export function kajabiConnFrom(c: Connection): KajabiConn {
  const cred = splitKajabiCredential(getSecretServerSide(c.secretRef));
  return {
    baseUrl: c.endpoint,
    clientId: cred?.clientId,
    clientSecret: cred?.clientSecret,
    fetchImpl: fetch,
  };
}

/** Resolve a Kajabi connection UNDER THE CALLER'S IDENTITY (DLS 404 — no
 *  existence leak), enforce the egress allowlist, and build the client config. */
export async function resolveKajabi(connId: string, user: CurrentUser): Promise<KajabiConn> {
  const { getConnectionForUser } = await import('@/lib/connections/store');
  const c = await getConnectionForUser(connId, user);
  if (c.template !== 'kajabi-api') {
    throw Object.assign(
      new Error(`Connection ${connId} is not an available sync source (warehouse catalog, Salesforce or Kajabi)`),
      { status: 400 },
    );
  }
  const egress = isEgressAllowed(c.endpoint);
  if (!egress.allowed) {
    throw Object.assign(
      new Error(`Egress to ${egress.host} is not allowlisted — request egress approval for the Kajabi API first`),
      { status: 403 },
    );
  }
  return kajabiConnFrom(c);
}

/** Resource discovery for the Connections browse surface — the SAME response shape
 *  a warehouse discover returns (schemas/tables), so the UI renders it unchanged.
 *  The token grant is a REAL round-trip (bad creds fail here honestly); the table
 *  list itself is the CURATED documented-resource map — Kajabi has no describe
 *  endpoint, and we never present guessed resources as discovered. */
export async function discoverKajabiResources(
  connId: string,
  user: CurrentUser,
): Promise<{ ok: boolean; schemas: string[]; tables: string[]; schema: string | null; detail: string }> {
  const conn = await resolveKajabi(connId, user);
  const token = await kjToken(conn);
  if (!token.ok) return { ok: false, schemas: [], tables: [], schema: null, detail: token.reason };
  const { KAJABI_RESOURCES } = await import('./kajabi-resources');
  return {
    ok: true,
    schemas: ['kajabi'],
    schema: 'kajabi',
    tables: KAJABI_RESOURCES.map((r) => r.name),
    detail: `${KAJABI_RESOURCES.length} documented resource(s) — a curated map (the public API has no describe endpoint). Only 'purchases' has a true update cursor; see each resource's sync note.`,
  };
}

/** The honest health probe (CONNECTION_HEALTH entry): a REAL token round-trip plus
 *  the cheapest authenticated read (`GET /v1/sites?page[size]=1`). Never fakes
 *  green; the credential never leaves this function. */
export async function kajabiHealth(c: Connection): Promise<{ ok: boolean; mode: 'live' | 'offline'; detail: string }> {
  const conn = kajabiConnFrom(c);
  const token = await kjToken(conn);
  if (!token.ok) return { ok: false, mode: 'offline', detail: token.reason };
  const probe = await kjListPage(conn, token.data, '/v1/sites', { page: 1, size: 1 });
  if (!probe.ok) return { ok: false, mode: 'offline', detail: probe.reason };
  return { ok: true, mode: 'live', detail: 'Token grant + GET /v1/sites round-trip succeeded.' };
}

// -------------------------------------------------- API-batch sync execution ----

export type KajabiSliceArgs = {
  connectionId: string;
  owner: CurrentUser;
  /** The Kajabi resource to sync (sync.source.table, e.g. 'purchases'). */
  resource: string;
  mode: 'full-refresh' | 'append';
  /** Exclusive lower bound (cursorBefore); null ⇒ first load / reset. */
  watermark: string | null;
  /** The dataset's physical slug — the data-runner derives `bronze_<slug>` from it. */
  datasetSlug: string;
  /** The Iceberg target (for the delete-by-batch-id retry idempotency). */
  target: SyncTarget;
  identity: ExecuteIdentity;
  execute: (sql: string, identity: ExecuteIdentity) => Promise<{ rowsAffected: number | null }>;
  /** Deterministic batch-id minting (the executor's sliceBatchId). */
  mkBatchId: (highWatermark: string) => string;
  /** Deterministic RETRY WINDOW from an unconfirmed prior attempt (incremental
   *  only): reuse ITS high watermark instead of probing a moved one, so the
   *  delete-by-batch-id un-lands exactly what that attempt landed. */
  window?: { highWatermark: string } | null;
  /** Called with the planned {highWatermark, batchId} BEFORE any row lands — the
   *  executor persists it as the 'running' dispatch marker (crash-safe retries). */
  onWindow?: (highWatermark: string, batchId: string) => void;
  /** Run-start timestamp — lands as `_loaded_at` on every row. */
  startedAt: string;
  // ---- test seams ----
  resolve?: (connId: string, owner: CurrentUser) => Promise<KajabiConn>;
  ingestUrl?: string;
  fetchImpl?: KjFetch;
};

/** POST one row batch to the data-runner's /ingest-rows (PyIceberg append path). */
async function postIngestRows(
  url: string,
  fetchImpl: KjFetch,
  payload: { principal: string; dataset: string; rows: Record<string, unknown>[]; mode: 'append' | 'replace' },
): Promise<void> {
  const res = await fetchImpl(`${url}/ingest-rows`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...serviceBearerHeader() },
    body: JSON.stringify(payload),
    cache: 'no-store',
  });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!res.ok || data.ok === false) {
    throw new Error(`data-runner /ingest-rows ${res.status}: ${data.error ?? 'failed'}`);
  }
}

/**
 * Run ONE Kajabi sync slice — the `api-batch` executor strategy, same honesty
 * contract as the Salesforce path: the high watermark (max cursor) is probed
 * BEFORE the pull; the caller advances the cursor only after this returns; a
 * first-load/reset streams with `replace` on its first batch (idempotent — a
 * crashed first load restarts clean and also CREATES the Bronze table); an
 * incremental slice deletes its deterministic batch first (retry idempotency) and
 * appends page-by-page. Rows are stamped with `_loaded_at` + `_batch_id` lineage.
 * A resource without a documented cursor honestly refuses incremental mode.
 */
export async function runKajabiSlice(
  a: KajabiSliceArgs,
): Promise<{ rowsAffected: number | null; batchId?: string; highWatermark: string | null }> {
  const conn = await (a.resolve ?? resolveKajabi)(a.connectionId, a.owner);
  const fetchImpl = a.fetchImpl ?? conn.fetchImpl;
  const token = await kjToken({ ...conn, fetchImpl });
  if (!token.ok) throw new Error(token.reason);
  const client = { ...conn, fetchImpl };
  const r = safeKajabiResource(a.resource);
  const firstLoad = a.mode === 'full-refresh' || a.watermark === null;

  if (a.mode === 'append' && r.cursor === null) {
    throw new Error(
      `kajabi: '${r.name}' documents no timestamp cursor — incremental sync is not supported; use full-refresh`,
    );
  }

  // 1. The slice's high watermark (cursored resources only): an unconfirmed prior
  //    attempt's window is REUSED (incremental only — deterministic retries, never
  //    a fresh probe over an unconfirmed slice); otherwise probe max(cursor)
  //    BEFORE the pull. Cursorless full refreshes have no watermark — their
  //    batch id derives from the run start instead.
  let highWatermark: string | null = null;
  if (r.cursor !== null) {
    if (!firstLoad && a.window) {
      highWatermark = kajabiDatetime(a.window.highWatermark);
    } else {
      const probe = await kjProbeMaxCursor(client, token.data, r.path, r.cursor);
      if (!probe.ok) throw new Error(probe.reason);
      if (probe.data === null) {
        return { rowsAffected: 0, highWatermark: null }; // empty resource — honestly nothing to sync
      }
      highWatermark = kajabiDatetime(probe.data);
    }
  }

  const watermark = firstLoad ? null : a.watermark;
  const batchId = a.mkBatchId(highWatermark ?? a.startedAt);

  // 2. Retry idempotency (incremental only): persist the dispatch marker, then
  //    un-land this batch before re-pulling. A first load streams `replace` on its
  //    first batch instead (see below) — replace IS its idempotency.
  if (!firstLoad && highWatermark !== null) {
    a.onWindow?.(highWatermark, batchId);
    await a.execute(deleteBatchSql(a.target, batchId), a.identity);
  }

  // 3. Stream the slice page-by-page to the data-runner (bounded memory).
  const ingestUrl = a.ingestUrl ?? config.dataRunnerUrl;
  let firstBatch = true;
  const pulled = await pullKajabiSlice({
    conn: client,
    token: token.data,
    resource: r.name,
    cursorField: r.cursor,
    watermark,
    highWatermark,
    onBatch: async (rows) => {
      const stamped = rows.map((row) => ({ ...row, _loaded_at: a.startedAt, _batch_id: batchId }));
      const mode: 'append' | 'replace' = firstLoad && firstBatch ? 'replace' : 'append';
      firstBatch = false;
      await postIngestRows(ingestUrl, fetchImpl, {
        principal: a.owner.id,
        dataset: a.datasetSlug,
        rows: stamped,
        mode,
      });
    },
  });
  if (!pulled.ok) throw new Error(pulled.reason);
  if (firstLoad && pulled.data === 0) {
    // Nothing landed ⇒ no Bronze table was created. Keep the cursor at "never
    // synced" so the NEXT run is again a first load — otherwise an incremental
    // run would delete-batch against a table that does not exist.
    return { rowsAffected: 0, highWatermark: null };
  }
  return { rowsAffected: pulled.data, batchId, highWatermark };
}
