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

/**
 * Salesforce REST client — the per-connection bridge to a customer's Salesforce org.
 *
 * HAND-BUILT (Connector Design Standard §4): Salesforce has no Trino connector and
 * no first-party MCP the OS can federate for governed server-to-server data pulls,
 * so this is a small typed REST client in the Airflow mold: the PURE client part
 * (`fetch` injected, credential injected as ARGS, never logged/returned, never
 * throws — `{ ok:false, reason }`) plus a thin SERVER-SIDE bridge that resolves the
 * connection under the caller's identity (DLS) and dereferences the vaulted secret
 * HERE (it never leaves the server).
 *
 * AUTH (v1): OAuth 2.0 **client-credentials** flow against a Connected App
 * (`grant_type=client_credentials`) — Salesforce's recommended server-to-server
 * grant. The ONE vaulted credential is `<consumer_key>:<consumer_secret>` (split on
 * the first `:` server-side), so the generic wizard needs no bespoke fields.
 * Username+password/security-token flow is NOT implemented (deprecated by
 * Salesforce for new integrations; would need multiple secrets).
 *
 * SYNC (the API-BATCH executor strategy): Trino cannot reach Salesforce, so an
 * incremental slice is pulled through the REST query API — `SELECT <fields> FROM
 * <Object> WHERE SystemModstamp > <watermark> AND SystemModstamp <= <hw> ORDER BY
 * SystemModstamp` (SystemModstamp is the canonical replication cursor) — and
 * streamed PAGE-BY-PAGE (the API's ~2000-record pages) to the data-runner's
 * `/ingest-rows`, which appends each batch to the Iceberg Bronze copy via
 * PyIceberg. Memory stays bounded: one page in flight, never the whole slice.
 *
 * HONEST LIMITS (v1): every pulled page consumes Salesforce API quota (bulk export
 * of a huge object can be expensive — schedule accordingly); DELETES are not
 * detected (no IsDeleted/queryAll — a v2 candidate); formula-field changes do not
 * bump SystemModstamp and are only picked up when the record is otherwise touched;
 * compound (address/location) and base64 blob fields are skipped.
 */

/** Injectable fetch — the global `fetch` in prod, a fake in tests. */
export type SfFetch = typeof fetch;

/** The Salesforce REST API version every path uses. */
export const SF_API_VERSION = 'v61.0';

/** A per-connection Salesforce client config. The secret fields never leave the
 *  server and are used ONLY to mint an access token. */
export type SfConn = {
  /** Org instance URL, e.g. https://yourorg.my.salesforce.com (no trailing slash). */
  instanceUrl: string;
  clientId?: string;
  clientSecret?: string;
  fetchImpl: SfFetch;
  timeoutMs?: number;
};

/** A Salesforce read that never throws: data, or an honest failure reason. */
export type SfRead<T> = { ok: true; data: T } | { ok: false; reason: string };

/** One page of a SOQL query result. */
export type SfQueryPage = {
  totalSize: number;
  done: boolean;
  nextRecordsUrl?: string;
  records: Record<string, unknown>[];
};

/** Split the ONE vaulted credential `<consumer_key>:<consumer_secret>` on the FIRST
 *  colon. Null on a malformed credential — surfaced honestly at call time. */
export function splitClientCredential(raw: string | null | undefined): { clientId: string; clientSecret: string } | null {
  const s = (raw ?? '').trim();
  const i = s.indexOf(':');
  if (i <= 0 || i === s.length - 1) return null;
  return { clientId: s.slice(0, i), clientSecret: s.slice(i + 1) };
}

/** An SObject / field name that is safe to fold into SOQL (SOQL identifiers are
 *  case-insensitive; custom objects/fields end in `__c`). Throws on anything else. */
export function safeSObjectName(name: string): string {
  const s = (name ?? '').trim();
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(s)) {
    throw Object.assign(new Error(`salesforce: unsafe object/field name '${name ?? ''}'`), { status: 400 });
  }
  return s;
}

/** Normalize a stored watermark / probed max into the SOQL datetime literal form
 *  (`YYYY-MM-DDTHH:mm:ss.sssZ`, unquoted in SOQL). Built via toISOString, so the
 *  output alphabet is fixed — nothing string-smuggled reaches the query. */
export function soqlDatetime(value: string): string {
  const t = Date.parse((value ?? '').trim());
  if (Number.isNaN(t)) {
    throw Object.assign(new Error(`salesforce: '${value}' is not a datetime`), { status: 400 });
  }
  return new Date(t).toISOString();
}

/** Escape a value for a single-quoted SOQL string literal. Salesforce SOQL escapes
 *  the backslash and single-quote; we ALSO strip control chars (incl. the newline a
 *  SOQL injection would need to smuggle a second clause) so a value can never break
 *  out of its quotes. The result is returned WITHOUT the surrounding quotes — the
 *  caller wraps it — so this is only ever used to build the inside of `'...'`. */
export function soqlStringLiteral(value: string): string {
  return String(value ?? '')
    // Strip ASCII control chars (incl. the newline/CR a second-clause injection
    // would need) BEFORE escaping, so a value can never break out of its quotes.
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f]/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'");
}

function base(conn: SfConn): string {
  return conn.instanceUrl.replace(/\/$/, '');
}

async function withTimeout(conn: SfConn, url: string, init: RequestInit): Promise<Response> {
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
export async function sfToken(conn: SfConn): Promise<SfRead<string>> {
  if (!conn.clientId || !conn.clientSecret) {
    return { ok: false, reason: 'credential must be <consumer_key>:<consumer_secret> (Connected App, client-credentials flow)' };
  }
  try {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: conn.clientId,
      client_secret: conn.clientSecret,
    });
    const res = await withTimeout(conn, `${base(conn)}/services/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString(),
    });
    const data = (await res.json().catch(() => ({}))) as { access_token?: string; error_description?: string; error?: string };
    if (!res.ok || !data.access_token) {
      return { ok: false, reason: `Salesforce token ${res.status}: ${data.error_description ?? data.error ?? 'no access_token'}` };
    }
    return { ok: true, data: data.access_token };
  } catch {
    return { ok: false, reason: 'Salesforce unreachable' };
  }
}

async function sfGet<T>(conn: SfConn, token: string, path: string): Promise<SfRead<T>> {
  try {
    const res = await withTimeout(conn, `${base(conn)}${path}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    if (res.status === 429) {
      return { ok: false, reason: `Salesforce rate-limited; retry after ${res.headers.get('retry-after') ?? '?'}s` };
    }
    const text = await res.text();
    if (!res.ok) return { ok: false, reason: `Salesforce ${res.status}: ${text.slice(0, 240)}` };
    return { ok: true, data: JSON.parse(text) as T };
  } catch {
    return { ok: false, reason: 'Salesforce unreachable' };
  }
}

/** The org's DailyApiRequests limit — the real numbers from `/limits` (Max + Remaining).
 *  Absent-safe: a missing/blank `/limits` yields null, and the pre-flight then changes
 *  NOTHING (the sync proceeds as before). NEVER fabricated. */
export type SfApiUsage = { max: number; remaining: number };

/**
 * Read the org's `/limits` and return the DailyApiRequests usage (Max + Remaining) — the
 * cheap governor read (one GET, no rows) the sync path pre-flights so a near-quota org can
 * record the honest "throttled — resuming next window" skip instead of hammering into a
 * hard 429. Returns null when the endpoint is unreachable or omits DailyApiRequests
 * (absent > fabricated — the caller treats null as "no signal, proceed").
 */
export async function sfLimits(conn: SfConn, token: string): Promise<SfRead<SfApiUsage | null>> {
  const res = await sfGet<Record<string, { Max?: number; Remaining?: number }>>(
    conn, token, `/services/data/${SF_API_VERSION}/limits`,
  );
  if (!res.ok) return res;
  const daily = res.data?.DailyApiRequests;
  if (!daily || typeof daily.Max !== 'number' || typeof daily.Remaining !== 'number') {
    return { ok: true, data: null };
  }
  return { ok: true, data: { max: daily.Max, remaining: daily.Remaining } };
}

/** Run one SOQL query (first page). */
export function sfQuery(conn: SfConn, token: string, soql: string): Promise<SfRead<SfQueryPage>> {
  return sfGet<SfQueryPage>(conn, token, `/services/data/${SF_API_VERSION}/query?q=${encodeURIComponent(soql)}`);
}

/** Follow a `nextRecordsUrl` to the next page. */
export function sfQueryMore(conn: SfConn, token: string, nextRecordsUrl: string): Promise<SfRead<SfQueryPage>> {
  return sfGet<SfQueryPage>(conn, token, nextRecordsUrl);
}

// ------------------------------------------- record-level action client (Phase 3) -

/** A safe Salesforce record id: 15- or 18-char base-62. Rejects anything else so an
 *  id can never smuggle path segments or SOQL. */
export function safeSalesforceId(id: string): string {
  const s = (id ?? '').trim();
  if (!/^[A-Za-z0-9]{15,18}$/.test(s)) {
    throw Object.assign(new Error(`salesforce: unsafe record id '${id ?? ''}'`), { status: 400 });
  }
  return s;
}

/** The hard cap on a `sf_search` LIMIT — the bounded-read ceiling. A caller may ask
 *  for fewer; anything above (or absent) clamps to this and the result carries a
 *  `truncated` flag when it fills the page. */
export const SF_SEARCH_MAX_LIMIT = 200;

/**
 * Build a bounded, INJECTION-SAFE SOQL SELECT from validated parts. Object + every
 * field name go through {@link safeSObjectName} (identifier-only). `where` clauses
 * are structured `{ field, value }` equality pairs — the field is an identifier, the
 * value is escaped into a single-quoted string literal ({@link soqlStringLiteral}) —
 * so raw user input is NEVER interpolated into SOQL. `term` adds a name-LIKE filter
 * against the standard `Name` field (also escaped). The LIMIT is clamped to
 * {@link SF_SEARCH_MAX_LIMIT}. Returns the SOQL and the effective limit.
 */
export function buildSearchSoql(input: {
  object: string;
  fields: string[];
  where?: { field: string; value: string }[];
  term?: string;
  limit?: number;
}): { soql: string; limit: number } {
  const obj = safeSObjectName(input.object);
  const fields = (input.fields.length ? input.fields : ['Id']).map(safeSObjectName);
  const select = [...new Set(['Id', ...fields])].join(', ');
  const clauses: string[] = [];
  for (const w of input.where ?? []) {
    const field = safeSObjectName(w.field);
    clauses.push(`${field} = '${soqlStringLiteral(w.value)}'`);
  }
  if (input.term && input.term.trim()) {
    clauses.push(`Name LIKE '%${soqlStringLiteral(input.term.trim())}%'`);
  }
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  const n = Number(input.limit);
  const limit = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), SF_SEARCH_MAX_LIMIT) : SF_SEARCH_MAX_LIMIT;
  return { soql: `SELECT ${select} FROM ${obj}${where} LIMIT ${limit}`, limit };
}

/** Read ONE record by id, optionally a `fields` projection (validated). Returns the
 *  record map (no `attributes` envelope), or the honest failure. */
export async function sfGetRecord(
  conn: SfConn,
  token: string,
  object: string,
  id: string,
  fields?: string[],
): Promise<SfRead<Record<string, unknown>>> {
  const obj = safeSObjectName(object);
  const rid = safeSalesforceId(id);
  const proj = (fields ?? []).map(safeSObjectName);
  const q = proj.length ? `?fields=${encodeURIComponent(proj.join(','))}` : '';
  const res = await sfGet<Record<string, unknown> & { attributes?: unknown }>(
    conn, token, `/services/data/${SF_API_VERSION}/sobjects/${obj}/${rid}${q}`,
  );
  if (!res.ok) return res;
  const { attributes: _attributes, ...rest } = res.data;
  return { ok: true, data: rest };
}

/** Write helper (POST create / PATCH update) — same never-throw contract as sfGet;
 *  429 surfaces the honest rate-limit reason. Body is the caller's validated values. */
async function sfWrite<T>(
  conn: SfConn,
  token: string,
  method: 'POST' | 'PATCH',
  path: string,
  body: Record<string, unknown>,
): Promise<SfRead<T>> {
  try {
    const res = await withTimeout(conn, `${base(conn)}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 429) {
      return { ok: false, reason: `Salesforce rate-limited; retry after ${res.headers.get('retry-after') ?? '?'}s` };
    }
    const text = await res.text();
    if (!res.ok) return { ok: false, reason: `Salesforce ${res.status}: ${text.slice(0, 240)}` };
    // PATCH returns 204 No Content on success; POST returns the created id.
    return { ok: true, data: (text ? JSON.parse(text) : {}) as T };
  } catch {
    return { ok: false, reason: 'Salesforce unreachable' };
  }
}

/** Only assignable string field names → their values reach the write body (field
 *  names validated as identifiers; a bad field name fails the whole write, honestly). */
function safeFieldValues(values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values ?? {})) {
    out[safeSObjectName(k)] = v;
  }
  return out;
}

/** CREATE one record. Returns `{ id }` on success (Salesforce's created id). */
export async function sfCreateRecord(
  conn: SfConn,
  token: string,
  object: string,
  values: Record<string, unknown>,
): Promise<SfRead<{ id: string }>> {
  const obj = safeSObjectName(object);
  const body = safeFieldValues(values);
  const res = await sfWrite<{ id?: string; success?: boolean }>(
    conn, token, 'POST', `/services/data/${SF_API_VERSION}/sobjects/${obj}`, body,
  );
  if (!res.ok) return res;
  if (!res.data.id) return { ok: false, reason: 'Salesforce create returned no id' };
  return { ok: true, data: { id: res.data.id } };
}

/** UPDATE one record by id (PATCH). Returns `{ id }` on success. */
export async function sfUpdateRecord(
  conn: SfConn,
  token: string,
  object: string,
  id: string,
  values: Record<string, unknown>,
): Promise<SfRead<{ id: string }>> {
  const obj = safeSObjectName(object);
  const rid = safeSalesforceId(id);
  const body = safeFieldValues(values);
  const res = await sfWrite<Record<string, unknown>>(
    conn, token, 'PATCH', `/services/data/${SF_API_VERSION}/sobjects/${obj}/${rid}`, body,
  );
  if (!res.ok) return res;
  return { ok: true, data: { id: rid } };
}

/** List the org's SObjects (describeGlobal) — the object-discovery read. Only
 *  queryable objects are returned (the rest cannot be SOQL'd anyway). */
export async function sfDescribeGlobal(conn: SfConn, token: string): Promise<SfRead<{ name: string; custom: boolean }[]>> {
  const res = await sfGet<{ sobjects?: { name?: string; queryable?: boolean; custom?: boolean }[] }>(
    conn, token, `/services/data/${SF_API_VERSION}/sobjects`,
  );
  if (!res.ok) return res;
  const objects = (res.data.sobjects ?? [])
    .filter((o) => o.queryable && typeof o.name === 'string')
    .map((o) => ({ name: o.name as string, custom: Boolean(o.custom) }));
  return { ok: true, data: objects };
}

/** The queryable scalar field names of one object (describe), for the SOQL select
 *  list. Compound (address/location) and base64 blob fields are skipped — they are
 *  not representable as flat lakehouse columns (their leaf components are). */
export async function sfDescribeFields(conn: SfConn, token: string, object: string): Promise<SfRead<string[]>> {
  const obj = safeSObjectName(object);
  const res = await sfGet<{ fields?: { name?: string; type?: string }[] }>(
    conn, token, `/services/data/${SF_API_VERSION}/sobjects/${obj}/describe`,
  );
  if (!res.ok) return res;
  const fields = (res.data.fields ?? [])
    .filter((f) => typeof f.name === 'string' && !['address', 'location', 'base64'].includes(String(f.type)))
    .map((f) => f.name as string)
    .filter((n) => /^[A-Za-z][A-Za-z0-9_]*$/.test(n));
  if (fields.length === 0) return { ok: false, reason: `object '${obj}' has no queryable scalar fields` };
  return { ok: true, data: fields };
}

/** One Salesforce field, described for the catalog browser: the API name, the SOAP
 *  type, and the human business `label` (Salesforce's field label — real metadata,
 *  never fabricated). Compound/blob fields are skipped like {@link sfDescribeFields}. */
export type SfFieldDetail = { name: string; type: string; label: string };

/**
 * The queryable scalar fields of one object WITH their business labels (describe) — the
 * lazy per-entity column expansion for the catalog browser (Phase 1). Same skip rules as
 * {@link sfDescribeFields} (address/location/base64 are not flat lakehouse columns); the
 * `label` is Salesforce's own field label (honest metadata, absent-safe → falls back to
 * the API name, never invented).
 */
export async function sfDescribeFieldsDetailed(
  conn: SfConn,
  token: string,
  object: string,
): Promise<SfRead<SfFieldDetail[]>> {
  const obj = safeSObjectName(object);
  const res = await sfGet<{ fields?: { name?: string; type?: string; label?: string }[] }>(
    conn, token, `/services/data/${SF_API_VERSION}/sobjects/${obj}/describe`,
  );
  if (!res.ok) return res;
  const fields = (res.data.fields ?? [])
    .filter((f) => typeof f.name === 'string' && !['address', 'location', 'base64'].includes(String(f.type)))
    .filter((f) => /^[A-Za-z][A-Za-z0-9_]*$/.test(String(f.name)))
    .map((f) => ({
      name: f.name as string,
      type: String(f.type ?? ''),
      label: (typeof f.label === 'string' && f.label.trim()) || (f.name as string),
    }));
  if (fields.length === 0) return { ok: false, reason: `object '${obj}' has no queryable scalar fields` };
  return { ok: true, data: fields };
}

/**
 * A cheap, REAL row count for one object — `SELECT COUNT() FROM <Object>` (aggregate
 * count, returns `totalSize` with no rows). Bounded (one query, no pages); the catalog
 * browser calls it only on row expand, on demand. Honest failure surfaces the reason;
 * an absent count is NEVER estimated.
 */
export async function sfCountRecords(conn: SfConn, token: string, object: string): Promise<SfRead<number>> {
  const obj = safeSObjectName(object);
  const res = await sfQuery(conn, token, `SELECT COUNT() FROM ${obj}`);
  if (!res.ok) return res;
  return { ok: true, data: res.data.totalSize ?? 0 };
}

/**
 * Pull one incremental slice PAGE-BY-PAGE, invoking `onBatch(records)` for every
 * API page (records already stripped of the `attributes` envelope). Bounded memory:
 * exactly one page is held at a time. Returns the total row count, or the honest
 * failure (rows already delivered to `onBatch` stay delivered — at-least-once).
 */
export async function pullSalesforceSlice(args: {
  conn: SfConn;
  token: string;
  object: string;
  fields: string[];
  /** Exclusive lower bound (null ⇒ everything up to the high watermark). */
  watermark: string | null;
  /** Inclusive upper bound — the probed high watermark. */
  highWatermark: string;
  onBatch: (records: Record<string, unknown>[]) => Promise<void>;
}): Promise<SfRead<number>> {
  const obj = safeSObjectName(args.object);
  const select = args.fields.map(safeSObjectName).join(', ');
  const upper = `SystemModstamp <= ${soqlDatetime(args.highWatermark)}`;
  const where = args.watermark === null ? upper : `SystemModstamp > ${soqlDatetime(args.watermark)} AND ${upper}`;
  const soql = `SELECT ${select} FROM ${obj} WHERE ${where} ORDER BY SystemModstamp`;

  let page = await sfQuery(args.conn, args.token, soql);
  let total = 0;
  // Defensive bound: pages are ~2000 records; this only stops a broken paginator
  // that loops, never a real slice (which the CronJob's activeDeadline also bounds).
  for (let i = 0; i < 10000; i++) {
    if (!page.ok) return page;
    const records = (page.data.records ?? []).map((r) => {
      const { attributes: _attributes, ...rest } = r as Record<string, unknown> & { attributes?: unknown };
      return rest;
    });
    if (records.length > 0) {
      await args.onBatch(records);
      total += records.length;
    }
    if (page.data.done || !page.data.nextRecordsUrl) return { ok: true, data: total };
    page = await sfQueryMore(args.conn, args.token, page.data.nextRecordsUrl);
  }
  return { ok: false, reason: 'Salesforce pagination did not terminate (nextRecordsUrl loop)' };
}

// ---------------------------------------------------------- server bridge -------

/** Build the client config from a Connection RECORD (health probe path). The vault
 *  secret is dereferenced HERE and never leaves the server. */
export function salesforceConnFrom(c: Connection): SfConn {
  const cred = splitClientCredential(getSecretServerSide(c.secretRef));
  return {
    instanceUrl: c.endpoint,
    clientId: cred?.clientId,
    clientSecret: cred?.clientSecret,
    fetchImpl: fetch,
  };
}

/** Resolve a Salesforce connection UNDER THE CALLER'S IDENTITY (DLS 404 — no
 *  existence leak), enforce the egress allowlist, and build the client config. */
export async function resolveSalesforce(connId: string, user: CurrentUser): Promise<SfConn> {
  const { getConnectionForUser } = await import('@/lib/connections/store');
  const c = await getConnectionForUser(connId, user);
  if (c.template !== 'salesforce-api') {
    throw Object.assign(
      new Error(`Connection ${connId} is not an available sync source (warehouse catalog or Salesforce)`),
      { status: 400 },
    );
  }
  const egress = isEgressAllowed(c.endpoint);
  if (!egress.allowed) {
    throw Object.assign(
      new Error(`Egress to ${egress.host} is not allowlisted — request egress approval for this Salesforce org first`),
      { status: 403 },
    );
  }
  return salesforceConnFrom(c);
}

/** Object discovery for the Connections browse surface — the SAME response shape a
 *  warehouse discover returns (schemas/tables), so the UI renders it unchanged. */
export async function discoverSalesforceObjects(
  connId: string,
  user: CurrentUser,
): Promise<{ ok: boolean; schemas: string[]; tables: string[]; schema: string | null; detail: string }> {
  const conn = await resolveSalesforce(connId, user);
  const token = await sfToken(conn);
  if (!token.ok) return { ok: false, schemas: [], tables: [], schema: null, detail: token.reason };
  const objects = await sfDescribeGlobal(conn, token.data);
  if (!objects.ok) return { ok: false, schemas: [], tables: [], schema: null, detail: objects.reason };
  return {
    ok: true,
    schemas: ['salesforce'],
    schema: 'salesforce',
    tables: objects.data.map((o) => o.name),
    detail: `${objects.data.length} queryable object(s) via REST describe.`,
  };
}

/** Describe ONE object's fields for the catalog browser — resolve the connection UNDER
 *  THE CALLER'S IDENTITY (DLS), mint a token, and return {name, type, label} per field.
 *  The catalog browser renders `label` (the business name) alongside the API `name`. */
export async function describeSalesforceObject(
  connId: string,
  user: CurrentUser,
  object: string,
): Promise<SfFieldDetail[]> {
  const conn = await resolveSalesforce(connId, user);
  const token = await sfToken(conn);
  if (!token.ok) throw Object.assign(new Error(token.reason), { status: 502 });
  const fields = await sfDescribeFieldsDetailed(conn, token.data, object);
  if (!fields.ok) throw Object.assign(new Error(fields.reason), { status: 502 });
  return fields.data;
}

/** True when the org is within `floor` fraction of its DailyApiRequests limit (near
 *  quota) — a PURE predicate over the real numbers so a slice can be skipped honestly
 *  before it hammers into a hard 429. Default floor 0.1 (skip with <10% budget left).
 *  Absent usage ⇒ false (no signal, proceed). */
export function nearApiQuota(usage: SfApiUsage | null, floor = 0.1): boolean {
  if (!usage || usage.max <= 0) return false;
  return usage.remaining / usage.max <= floor;
}

/** Read the org's DailyApiRequests usage AS the sync's identity — a cheap `/limits` GET.
 *  Returns null on any failure/omission (absent > fabricated); the caller then proceeds
 *  unchanged. Never throws — a limits hiccup must never fail an otherwise-fine sync. */
export async function salesforceApiUsage(connId: string, user: CurrentUser): Promise<SfApiUsage | null> {
  try {
    const conn = await resolveSalesforce(connId, user);
    const token = await sfToken(conn);
    if (!token.ok) return null;
    const limits = await sfLimits(conn, token.data);
    return limits.ok ? limits.data : null;
  } catch {
    return null;
  }
}

/** A REAL on-demand row count for one object (SELECT COUNT()) — resolved AS the caller.
 *  Returns the number, or throws the honest reason (never an estimate). */
export async function countSalesforceObject(connId: string, user: CurrentUser, object: string): Promise<number> {
  const conn = await resolveSalesforce(connId, user);
  const token = await sfToken(conn);
  if (!token.ok) throw Object.assign(new Error(token.reason), { status: 502 });
  const count = await sfCountRecords(conn, token.data, object);
  if (!count.ok) throw Object.assign(new Error(count.reason), { status: 502 });
  return count.data;
}

/** The honest health probe (CONNECTION_HEALTH entry): a REAL token round-trip plus
 *  a trivial query. Never fakes green; the credential never leaves this function. */
export async function salesforceHealth(c: Connection): Promise<{ ok: boolean; mode: 'live' | 'offline'; detail: string }> {
  const conn = salesforceConnFrom(c);
  const token = await sfToken(conn);
  if (!token.ok) return { ok: false, mode: 'offline', detail: token.reason };
  const probe = await sfQuery(conn, token.data, 'SELECT Id FROM Organization LIMIT 1');
  if (!probe.ok) return { ok: false, mode: 'offline', detail: probe.reason };
  return { ok: true, mode: 'live', detail: 'Token grant + SELECT Id FROM Organization round-trip succeeded.' };
}

// -------------------------------------------------- API-batch sync execution ----

export type SalesforceSliceArgs = {
  connectionId: string;
  owner: CurrentUser;
  /** The SObject to sync (sync.source.table — SOQL is case-insensitive). */
  object: string;
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
  resolve?: (connId: string, owner: CurrentUser) => Promise<SfConn>;
  ingestUrl?: string;
  fetchImpl?: SfFetch;
};

/** POST one row batch to the data-runner's /ingest-rows (PyIceberg append path). */
async function postIngestRows(
  url: string,
  fetchImpl: SfFetch,
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
 * Run ONE Salesforce sync slice — the `api-batch` executor strategy. Same honesty
 * contract as the SQL path: the high watermark (max SystemModstamp) is probed
 * BEFORE the pull; the caller advances the cursor only after this returns; a
 * first-load/reset streams with `replace` on its first batch (idempotent — a
 * crashed first load restarts clean and also CREATES the Bronze table); an
 * incremental slice deletes its deterministic batch first (retry idempotency) and
 * appends page-by-page. Rows are stamped with `_loaded_at` + `_batch_id` lineage.
 */
export async function runSalesforceSlice(
  a: SalesforceSliceArgs,
): Promise<{ rowsAffected: number | null; batchId?: string; highWatermark: string | null }> {
  const conn = await (a.resolve ?? resolveSalesforce)(a.connectionId, a.owner);
  const fetchImpl = a.fetchImpl ?? conn.fetchImpl;
  const token = await sfToken({ ...conn, fetchImpl });
  if (!token.ok) throw new Error(token.reason);
  const client = { ...conn, fetchImpl };
  const object = safeSObjectName(a.object);
  const firstLoad = a.mode === 'full-refresh' || a.watermark === null;

  // 1. The slice's high watermark: an unconfirmed prior attempt's window is REUSED
  //    (incremental only — deterministic retries, never a fresh probe over an
  //    unconfirmed slice); otherwise probe max(SystemModstamp) BEFORE the pull.
  let highWatermark: string;
  if (!firstLoad && a.window) {
    highWatermark = soqlDatetime(a.window.highWatermark);
  } else {
    const probe = await sfQuery(client, token.data, `SELECT MAX(SystemModstamp) FROM ${object}`);
    if (!probe.ok) throw new Error(probe.reason);
    const rawMax = (probe.data.records?.[0] as Record<string, unknown> | undefined)?.expr0;
    if (rawMax === undefined || rawMax === null || rawMax === '') {
      return { rowsAffected: 0, highWatermark: null }; // empty object — honestly nothing to sync
    }
    highWatermark = soqlDatetime(String(rawMax));
  }

  // 2. Field list via describe (SOQL has no `SELECT *`).
  const fields = await sfDescribeFields(client, token.data, object);
  if (!fields.ok) throw new Error(fields.reason);
  if (!fields.data.some((f) => f.toLowerCase() === 'systemmodstamp')) {
    throw new Error(`object '${object}' has no SystemModstamp field — not syncable incrementally`);
  }

  const watermark = firstLoad ? null : a.watermark;
  const batchId = a.mkBatchId(highWatermark);

  // 3. Retry idempotency (incremental only): persist the dispatch marker, then
  //    un-land this batch before re-pulling. A first load streams `replace` on its
  //    first batch instead (see below) — replace IS its idempotency.
  if (!firstLoad) {
    a.onWindow?.(highWatermark, batchId);
    await a.execute(deleteBatchSql(a.target, batchId), a.identity);
  }

  // 4. Stream the slice page-by-page to the data-runner (bounded memory).
  const ingestUrl = a.ingestUrl ?? config.dataRunnerUrl;
  let firstBatch = true;
  const pulled = await pullSalesforceSlice({
    conn: client,
    token: token.data,
    object,
    fields: fields.data,
    watermark,
    highWatermark,
    onBatch: async (records) => {
      const rows = records.map((r) => ({ ...r, _loaded_at: a.startedAt, _batch_id: batchId }));
      const mode: 'append' | 'replace' = firstLoad && firstBatch ? 'replace' : 'append';
      firstBatch = false;
      await postIngestRows(ingestUrl, fetchImpl, {
        principal: a.owner.id,
        dataset: a.datasetSlug,
        rows,
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
