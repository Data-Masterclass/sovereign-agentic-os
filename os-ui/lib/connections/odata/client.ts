/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/core/auth';
import type { Connection } from '@/lib/connections/schema';
import { getSecretServerSide, isEgressAllowed } from '@/lib/infra/secrets';
import { fetchWithBackoff } from '@/lib/connections/retry';
import { parseEdmx, type ODataModel } from './metadata.ts';
import { dialectFor, type ODataDialect } from './dialect.ts';

/**
 * OData REST client — the server-only bridge to a customer's cloud-reachable OData
 * service (operational-system-connections.md, Phase 4, decision 3). It backs BOTH the
 * branded `sap-odata` template (S/4HANA Cloud communication arrangement) and the generic
 * unbranded `odata-v4` template (Dynamics 365 / Business Central) — SAME core, honest
 * v1 caveat: an on-prem service behind the SAP Cloud Connector is NOT reachable and is
 * out of scope.
 *
 * Follows the Connector Design Standard (§1.2 pure/bridge split): the PURE parts are the
 * EDMX parser (metadata.ts) and the version dialect (dialect.ts); THIS module is the
 * server bridge — it resolves the connection UNDER THE CALLER'S IDENTITY (DLS 404),
 * dereferences the vaulted secret HERE (never returns/logs it), enforces the egress
 * allowlist, and injects auth into the outbound call. Never throws to the caller —
 * `{ ok:false, reason }` — and honors Retry-After via fetchWithBackoff.
 *
 * AUTH (v1, reusing the salesforce.ts patterns):
 *   • Basic — a communication user; the ONE vaulted credential is `<user>:<password>`
 *     (split on the first colon, server-side).
 *   • OAuth2 client-credentials — the ONE vaulted credential is
 *     `<client_id>:<client_secret>`; the token endpoint is the connection's non-secret
 *     `odata.tokenUrl`. Exactly the Salesforce client-credentials grant, generalized.
 */

export type OdFetch = (url: string, init?: RequestInit) => Promise<Response>;

/** A read that never throws: data, or an honest failure reason. */
export type OdRead<T> = { ok: true; data: T } | { ok: false; reason: string };

/** The per-connection OData client config. Secret fields never leave the server. */
export type OdConn = {
  /** The OData service ROOT (no trailing slash), e.g. https://host/sap/opu/odata/sap/API_X. */
  serviceRoot: string;
  authType: 'basic' | 'oauth-cc';
  /** Basic: `<user>:<password>`. OAuth-CC: `<client_id>:<client_secret>`. */
  user?: string;
  pass?: string;
  /** OAuth-CC token endpoint (non-secret config). */
  tokenUrl?: string;
  fetchImpl: OdFetch;
  timeoutMs?: number;
};

function base(conn: OdConn): string {
  return conn.serviceRoot.replace(/\/$/, '');
}

/** Split the ONE vaulted credential `<a>:<b>` on the FIRST colon (user:pass or id:secret). */
export function splitCredential(raw: string | null | undefined): { user: string; pass: string } | null {
  const s = (raw ?? '').trim();
  const i = s.indexOf(':');
  if (i <= 0 || i === s.length - 1) return null;
  return { user: s.slice(0, i), pass: s.slice(i + 1) };
}

/** An OData entity-set / property name safe to fold into a URL path/query segment.
 *  OData identifiers are letters/digits/underscore; reject anything else so a name can
 *  never smuggle query operators or path segments. */
export function safeODataName(name: string): string {
  const s = (name ?? '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) {
    throw Object.assign(new Error(`odata: unsafe entity/property name '${name ?? ''}'`), { status: 400 });
  }
  return s;
}

async function withTimeout(conn: OdConn, url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), conn.timeoutMs ?? 30000);
  try {
    return await fetchWithBackoff(url, { ...init, signal: ctrl.signal, cache: 'no-store' }, (u, i) => conn.fetchImpl(u, i));
  } finally {
    clearTimeout(timer);
  }
}

/** Mint an OAuth2 client-credentials bearer (OAuth-CC auth only). The secret is used ONLY
 *  to build the form body; only the token is returned, never the credential. */
async function odToken(conn: OdConn): Promise<OdRead<string>> {
  if (!conn.tokenUrl) return { ok: false, reason: 'OAuth client-credentials needs a token URL' };
  if (!conn.user || !conn.pass) return { ok: false, reason: 'credential must be <client_id>:<client_secret> for OAuth client-credentials' };
  try {
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: conn.user, client_secret: conn.pass });
    const res = await withTimeout(conn, conn.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString(),
    });
    const data = (await res.json().catch(() => ({}))) as { access_token?: string; error_description?: string; error?: string };
    if (!res.ok || !data.access_token) {
      return { ok: false, reason: `OData token ${res.status}: ${data.error_description ?? data.error ?? 'no access_token'}` };
    }
    return { ok: true, data: data.access_token };
  } catch {
    return { ok: false, reason: 'OData token endpoint unreachable' };
  }
}

/** Build the Authorization header for a request — Basic (communication user) inline, or a
 *  freshly-minted OAuth-CC bearer. The credential is used ONLY to build the header. */
async function authHeaders(conn: OdConn): Promise<OdRead<Record<string, string>>> {
  if (conn.authType === 'oauth-cc') {
    const t = await odToken(conn);
    if (!t.ok) return t;
    return { ok: true, data: { authorization: `Bearer ${t.data}` } };
  }
  if (!conn.user || !conn.pass) return { ok: false, reason: 'credential must be <user>:<password> for Basic auth' };
  const b64 = Buffer.from(`${conn.user}:${conn.pass}`).toString('base64');
  return { ok: true, data: { authorization: `Basic ${b64}` } };
}

/** GET a JSON body from an ABSOLUTE url (used for pages + nextLinks). Never throws. */
async function odGetJson(conn: OdConn, headers: Record<string, string>, url: string): Promise<OdRead<Record<string, unknown>>> {
  try {
    const res = await withTimeout(conn, url, { method: 'GET', headers: { ...headers, accept: 'application/json' } });
    if (res.status === 429) {
      return { ok: false, reason: `OData rate-limited; retry after ${res.headers.get('retry-after') ?? '?'}s` };
    }
    const text = await res.text();
    if (!res.ok) return { ok: false, reason: `OData ${res.status}: ${text.slice(0, 240)}` };
    try {
      return { ok: true, data: JSON.parse(text) as Record<string, unknown> };
    } catch {
      return { ok: false, reason: 'OData returned a non-JSON body (is $format=json supported?)' };
    }
  } catch {
    return { ok: false, reason: 'OData service unreachable' };
  }
}

/** Fetch + parse the service `$metadata` (EDMX). Honest failure reason on any hiccup. */
export async function fetchMetadata(conn: OdConn): Promise<OdRead<ODataModel>> {
  const auth = await authHeaders(conn);
  if (!auth.ok) return auth;
  // $metadata is XML — request it explicitly (some services 406 on accept: json here).
  try {
    const res = await withTimeout(conn, `${base(conn)}/$metadata`, {
      method: 'GET',
      headers: { ...auth.data, accept: 'application/xml' },
    });
    if (res.status === 429) return { ok: false, reason: `OData rate-limited; retry after ${res.headers.get('retry-after') ?? '?'}s` };
    const text = await res.text();
    if (!res.ok) return { ok: false, reason: `OData $metadata ${res.status}: ${text.slice(0, 240)}` };
    if (!/<[\w:]*Edmx/i.test(text) && !/<[\w:]*EntityType/i.test(text)) {
      return { ok: false, reason: 'OData $metadata did not return EDMX' };
    }
    return { ok: true, data: parseEdmx(text) };
  } catch {
    return { ok: false, reason: 'OData $metadata unreachable' };
  }
}

/** The absolute URL for the FIRST page of an entity-set slice, honoring the dialect for
 *  the count param and building a `$filter <cursor> gt <literal>` when a cursor is set. */
export function firstPageUrl(
  conn: OdConn,
  dialect: ODataDialect,
  input: {
    entitySet: string;
    cursorColumn?: string | null;
    cursorType?: string;
    /** Exclusive lower bound (watermark). Undefined ⇒ full slice. */
    watermark?: string | null;
    /** Inclusive upper bound (the probed high watermark). */
    highWatermark?: string | null;
    pageSize?: number;
  },
): string {
  const set = safeODataName(input.entitySet);
  const params = new URLSearchParams();
  const count = dialect.countParam();
  params.set(count.key, count.value);
  params.set('$format', 'json');
  if (input.pageSize && input.pageSize > 0) params.set('$top', String(Math.floor(input.pageSize)));
  if (input.cursorColumn) {
    const col = safeODataName(input.cursorColumn);
    const clauses: string[] = [];
    const edm = input.cursorType ?? 'Edm.DateTimeOffset';
    if (input.watermark) clauses.push(`${col} gt ${dialect.dateLiteral(input.watermark, edm)}`);
    if (input.highWatermark) clauses.push(`${col} le ${dialect.dateLiteral(input.highWatermark, edm)}`);
    if (clauses.length) params.set('$filter', clauses.join(' and '));
    params.set('$orderby', `${col} asc`);
  }
  return `${base(conn)}/${set}?${params.toString()}`;
}

/** One page of an entity-set slice: the rows (dialect-extracted), the server's next-page
 *  link (null on the last page), and the inlined total count (null when omitted). */
export type OdPage = { rows: Record<string, unknown>[]; nextLink: string | null; count: number | null };

/** Fetch one page from an absolute url + parse it through the dialect. */
export async function pullPage(conn: OdConn, dialect: ODataDialect, url: string): Promise<OdRead<OdPage>> {
  const auth = await authHeaders(conn);
  if (!auth.ok) return auth;
  const res = await odGetJson(conn, auth.data, url);
  if (!res.ok) return res;
  return {
    ok: true,
    data: {
      rows: dialect.rows(res.data),
      nextLink: dialect.nextLink(res.data),
      count: dialect.count(res.data),
    },
  };
}

// ---------------------------------------------------------- server bridge -------

/** True when a template is served by the OData core. */
export function isODataTemplate(template: string): boolean {
  return template === 'sap-odata' || template === 'odata-v4';
}

/** Build the client config from a Connection RECORD (health-probe path). The vault secret
 *  is dereferenced HERE and never leaves the server. */
export function odataConnFrom(c: Connection): OdConn {
  const cred = splitCredential(getSecretServerSide(c.secretRef));
  const authType = c.odata?.authType ?? 'basic';
  return {
    serviceRoot: c.endpoint,
    authType,
    user: cred?.user,
    pass: cred?.pass,
    tokenUrl: c.odata?.tokenUrl,
    fetchImpl: (u, i) => fetch(u, i),
  };
}

/** Resolve an OData connection UNDER THE CALLER'S IDENTITY (DLS 404), enforce the egress
 *  allowlist, and build the client config. */
export async function resolveODataConn(connId: string, user: CurrentUser): Promise<OdConn> {
  const { getConnectionForUser } = await import('@/lib/connections/store');
  const c = await getConnectionForUser(connId, user);
  if (!isODataTemplate(c.template)) {
    throw Object.assign(new Error(`Connection ${connId} is not an OData connection`), { status: 400 });
  }
  const egress = isEgressAllowed(c.endpoint);
  if (!egress.allowed) {
    throw Object.assign(
      new Error(`Egress to ${egress.host} is not allowlisted — request egress approval for this OData service first`),
      { status: 403 },
    );
  }
  return odataConnFrom(c);
}

/** Entity discovery for the Connections browse surface — the SAME response shape a
 *  warehouse discover returns (schemas/tables), so the UI renders it unchanged. The
 *  pseudo-schema is the platform label; the "tables" are the entity-set names. */
export async function discoverODataEntities(
  connId: string,
  user: CurrentUser,
): Promise<{ ok: boolean; schemas: string[]; tables: string[]; schema: string | null; detail: string }> {
  const conn = await resolveODataConn(connId, user);
  const meta = await fetchMetadata(conn);
  if (!meta.ok) return { ok: false, schemas: [], tables: [], schema: null, detail: meta.reason };
  const pseudo = meta.data.version === 'V2' ? 'odata' : 'odata';
  return {
    ok: true,
    schemas: [pseudo],
    schema: pseudo,
    tables: meta.data.entitySets.map((s) => s.name),
    detail: `${meta.data.entitySets.length} entity set(s) via OData ${meta.data.version} $metadata.`,
  };
}

/** Describe ONE entity's fields for the catalog browser — {name, type, label} per scalar
 *  property (labels from `sap:label` where present). Resolves AS the caller (DLS). */
export async function describeODataEntity(
  connId: string,
  user: CurrentUser,
  entitySet: string,
): Promise<{ name: string; type: string; label: string }[]> {
  const conn = await resolveODataConn(connId, user);
  const meta = await fetchMetadata(conn);
  if (!meta.ok) throw Object.assign(new Error(meta.reason), { status: 502 });
  const set = meta.data.entitySets.find((s) => s.name.toLowerCase() === entitySet.trim().toLowerCase());
  if (!set) throw Object.assign(new Error(`entity set '${entitySet}' not found in $metadata`), { status: 404 });
  const type = meta.data.entityTypes[set.entityType];
  if (!type) return [];
  return type.properties.map((p) => ({ name: p.name, type: p.type, label: p.label }));
}

/** A REAL, cheap row count for one entity set — `$count`/`$inlinecount` inlined on a
 *  0-row top page (bounded). Resolved AS the caller. Null when the server omits it
 *  (absent > fabricated). Throws the honest reason on an unreachable service. */
export async function countODataEntity(connId: string, user: CurrentUser, entitySet: string): Promise<number | null> {
  const conn = await resolveODataConn(connId, user);
  const meta = await fetchMetadata(conn);
  if (!meta.ok) throw Object.assign(new Error(meta.reason), { status: 502 });
  const dialect = dialectFor(meta.data.version);
  const url = firstPageUrl(conn, dialect, { entitySet, pageSize: 0 });
  const page = await pullPage(conn, dialect, url);
  if (!page.ok) throw Object.assign(new Error(page.reason), { status: 502 });
  return page.data.count;
}

/** The honest health probe (CONNECTION_HEALTH entry): a REAL `$metadata` round-trip. Never
 *  fakes green; the credential never leaves this function. */
export async function odataHealth(c: Connection): Promise<{ ok: boolean; mode: 'live' | 'offline'; detail: string }> {
  const conn = odataConnFrom(c);
  const meta = await fetchMetadata(conn);
  if (!meta.ok) return { ok: false, mode: 'offline', detail: meta.reason };
  return {
    ok: true,
    mode: 'live',
    detail: `$metadata parsed: OData ${meta.data.version}, ${meta.data.entitySets.length} entity set(s).`,
  };
}

/**
 * REAL, thin READ executor for an ALREADY-ALLOWED OData tool (C2). The governance gate
 * (both are Read) has passed upstream in `callConnectionTool`; here we make the real
 * $metadata / page round-trip so the tool result is live, not fabricated. Never throws —
 * every failure degrades to `{ ok:false, reason }`. The credential is dereferenced from
 * the vault inside `odataConnFrom` and never logged/returned.
 *
 *   • odata_list_entities → the entity-set names from $metadata (live).
 *   • odata_read_entity   → one bounded page of an entity set (default $top 20, ≤ 200).
 */
export async function executeODataTool(c: Connection, tool: string, args: Record<string, unknown>): Promise<unknown> {
  const conn = odataConnFrom(c);
  const fail = (reason: string) => ({ connection: c.name, ok: false as const, reason });
  const meta = await fetchMetadata(conn);
  if (!meta.ok) return fail(meta.reason);
  const dialect = dialectFor(meta.data.version);
  if (tool === 'odata_list_entities') {
    return { connection: c.name, ok: true as const, version: meta.data.version, entitySets: meta.data.entitySets.map((s) => s.name) };
  }
  if (tool === 'odata_read_entity') {
    const entitySet = String(args.entitySet ?? args.entity ?? '');
    if (!entitySet) return fail('odata_read_entity needs an entitySet');
    const set = meta.data.entitySets.find((s) => s.name.toLowerCase() === entitySet.trim().toLowerCase());
    if (!set) return fail(`entity set '${entitySet}' not found in $metadata`);
    const pageSize = Math.min(Math.max(Number(args.limit ?? 20) || 20, 1), 200);
    let url: string;
    try {
      url = firstPageUrl(conn, dialect, { entitySet: set.name, pageSize });
    } catch (e) {
      return fail(e instanceof Error ? e.message : 'bad entity set name');
    }
    const page = await pullPage(conn, dialect, url);
    if (!page.ok) return fail(page.reason);
    return { connection: c.name, ok: true as const, entitySet: set.name, rows: page.data.rows, count: page.data.count, truncated: page.data.nextLink !== null };
  }
  return fail(`Unknown OData tool: ${tool}`);
}
