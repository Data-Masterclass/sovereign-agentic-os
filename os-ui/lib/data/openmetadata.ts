/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { CatalogAsset, SourceSeverity } from './catalog.ts';

/**
 * OpenMetadata client — the CORE metadata backbone behind the Data-tab Catalog.
 *
 * OpenMetadata is DEPLOYED in-cluster and is NOT an optional add-on: the Catalog
 * treats it as the governed catalog's system of record. This module is PURE and
 * testable — `fetch` is injected so the health probe, the table pull and the
 * honest-degradation path are all unit-tested against fakes (no live cluster).
 *
 * Two independent signals, kept separate on purpose:
 *   • CONNECTIVITY (health) — does OM answer at all? This uses the UNAUTHENTICATED
 *     `/api/v1/system/version` endpoint, so the Catalog can show OM as CONNECTED
 *     even before a bot token is minted. ANY HTTP response (even 401) means the
 *     server is up; only a network error / timeout is "reconnecting…". This is
 *     what removes the old "optional · not connected" framing.
 *   • ENRICHMENT (table pull) — the governed catalog reflected back from OM. This
 *     needs the bot JWT; without it OM is still CONNECTED and the governed marts
 *     are deep-linked into OM, we simply don't pull OM's own table list.
 *
 * The contract: an unreachable OM NEVER throws to the caller — it degrades to a
 * clear, non-alarming "reconnecting…" status so the Catalog keeps rendering.
 */

/** Injectable fetch — the global `fetch` in prod, a fake in tests. */
export type OmFetch = typeof fetch;

export type OmHealth = {
  /** True when OM answered (any HTTP status) — the server is up. */
  connected: boolean;
  /** OM build version, when the version endpoint returned it (200 + JSON). */
  version?: string;
  /** Why we could not reach OM (network/timeout), for an honest status. */
  reason?: string;
};

/** The shape the Catalog assembler consumes for the OpenMetadata source. */
export type OmSource = {
  /** Pulled OM tables, or null when nothing was pulled (still may be connected). */
  assets: CatalogAsset[] | null;
  status: string;
  severity?: SourceSeverity;
  /** Explicit source health — CONNECTED counts as ok even with 0 pulled tables. */
  ok?: boolean;
  /** Explicit count for the UI pill (governed marts mirrored when we pull nothing). */
  count?: number;
  /** Live connectivity, surfaced so the route only deep-links when OM is up. */
  connected: boolean;
  version?: string;
};

async function withTimeout(
  fetchImpl: OmFetch,
  url: string,
  init: RequestInit,
  ms: number,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetchImpl(url, { ...init, signal: ctrl.signal, cache: 'no-store' });
  } finally {
    clearTimeout(timer);
  }
}

function authHeaders(jwt?: string): Record<string, string> {
  const h: Record<string, string> = { accept: 'application/json' };
  if (jwt) h.authorization = `Bearer ${jwt}`;
  return h;
}

/**
 * Liveness probe against `/api/v1/system/version`. ANY HTTP response means OM is
 * up (connected); a network error / timeout means it is genuinely unreachable.
 * The JWT is sent when present but is NOT required to establish connectivity, so
 * the Catalog reads CONNECTED as soon as OM is deployed — token or not.
 */
export async function openMetadataHealth(opts: {
  apiUrl: string;
  jwt?: string;
  fetchImpl: OmFetch;
  timeoutMs?: number;
}): Promise<OmHealth> {
  try {
    const res = await withTimeout(
      opts.fetchImpl,
      `${opts.apiUrl}/api/v1/system/version`,
      { method: 'GET', headers: authHeaders(opts.jwt) },
      opts.timeoutMs ?? 2500,
    );
    // The server answered — it is up regardless of auth status. Parse the version
    // only on a clean 200 body; anything else still counts as CONNECTED.
    let version: string | undefined;
    if (res.ok) {
      try {
        const j = (await res.json()) as { version?: string };
        if (j?.version) version = String(j.version);
      } catch {
        /* version is best-effort; connectivity already established */
      }
    }
    return { connected: true, version };
  } catch {
    return { connected: false, reason: 'unreachable' };
  }
}

/**
 * Pull OM's own table list (requires the bot JWT). Shaped into CatalogAssets and
 * labelled `openmetadata`. Throws on a non-OK response / bad shape so the caller
 * can degrade honestly — connectivity is proven separately by the health probe.
 */
export async function fetchOpenMetadataTables(opts: {
  apiUrl: string;
  jwt: string;
  fetchImpl: OmFetch;
  limit?: number;
  timeoutMs?: number;
}): Promise<CatalogAsset[]> {
  const res = await withTimeout(
    opts.fetchImpl,
    `${opts.apiUrl}/api/v1/tables?limit=${opts.limit ?? 50}&fields=description`,
    { method: 'GET', headers: authHeaders(opts.jwt) },
    opts.timeoutMs ?? 2500,
  );
  if (!res.ok) throw new Error(`OpenMetadata ${res.status}`);
  const data = (await res.json()) as { data?: Record<string, unknown>[] };
  if (!Array.isArray(data?.data)) throw new Error('OpenMetadata returned no table list');
  return data.data.map((t) => ({
    name: String(t.name ?? ''),
    fqn: String(t.fullyQualifiedName ?? t.name ?? ''),
    description: String(t.description ?? ''),
    type: 'table',
    source: 'openmetadata' as const,
  }));
}

/**
 * Browser deep link to the OpenMetadata entity page for a governed Iceberg mart.
 *
 * An OS mart FQN is `iceberg.<schema>.<table>` (Trino catalog `iceberg`). In OM a
 * Trino service ingests that as `<service>.<catalog>.<schema>.<table>`, i.e. the
 * OM FQN is simply `<service>.<icebergFqn>`. Returns null for non-Iceberg FQNs
 * (e.g. an un-materialized `registry:<id>`) so we never emit a nonsense link.
 */
export function omEntityUrl(consoleBase: string, service: string, icebergFqn: string): string | null {
  if (!consoleBase || !icebergFqn.startsWith('iceberg.')) return null;
  const omFqn = `${service}.${icebergFqn}`;
  return `${consoleBase}/table/${encodeURIComponent(omFqn)}`;
}

// ======================================================================
// PER-CONNECTION OpenMetadata client (Phase 1 — read / discover only)
// ======================================================================
//
// The functions ABOVE talk to the ONE bundled in-cluster OM via config globals.
// The functions BELOW take an explicit base URL + bearer token as ARGS, so an
// EXTERNAL OM modelled as an `om-catalog` Connection can be read per-connection
// (its bot JWT comes from the connection's vaulted secretRef — never a global).
//
// Same discipline as above: `fetch` is injected, the token is sent as a Bearer
// header and NEVER logged/returned, and every read NEVER throws to the caller —
// it degrades to `{ ok: false, reason }` so discovery keeps rendering.
//
// HARD GUARDRAIL (Phase 1): read only. There is NO POST/PUT/PATCH helper here.
// `detectOmVersion` records the OM build so a future (Phase 2) write path can
// refuse writes on an unknown/unsupported version — but this phase never writes.

/** A per-connection OM client config: where + how to authenticate. */
export type OmConn = {
  /** OM base URL (the connection endpoint), e.g. https://om.example.com. */
  baseUrl: string;
  /** OM bot JWT (resolved from the connection's vaulted secretRef, server-side). */
  token?: string;
  fetchImpl: OmFetch;
  timeoutMs?: number;
};

/** An OM read that never throws: either data, or an honest failure reason. */
export type OmRead<T> =
  | { ok: true; data: T }
  | { ok: false; reason: string };

/** A lightly-typed OM domain (only the fields discovery needs). */
export type OmDomain = { name: string; fqn: string; description: string };
/** A lightly-typed OM data product. */
export type OmDataProduct = { name: string; fqn: string; description: string };

/** GET one OM path under this connection, never throwing. Bearer token injected
 *  when present; a non-OK status or a network error becomes an honest reason. */
async function omGet(conn: OmConn, path: string): Promise<OmRead<unknown>> {
  const base = conn.baseUrl.replace(/\/$/, '');
  try {
    const res = await withTimeout(
      conn.fetchImpl,
      `${base}${path}`,
      { method: 'GET', headers: authHeaders(conn.token) },
      conn.timeoutMs ?? 2500,
    );
    if (!res.ok) return { ok: false, reason: `OpenMetadata ${res.status}` };
    return { ok: true, data: await res.json() };
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
}

/** Read a `{ data: [...] }` list body into a name/fqn/description shape. */
function shapeList(data: unknown): { name: string; fqn: string; description: string }[] {
  const rows = (data as { data?: Record<string, unknown>[] })?.data;
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => ({
    name: String(r.name ?? ''),
    fqn: String(r.fullyQualifiedName ?? r.name ?? ''),
    description: String(r.description ?? ''),
  }));
}

/** OM build version for this connection (records it so the client can pick stable
 *  API shapes and, in Phase 2, refuse writes on an unknown version). Unauth-safe:
 *  the version endpoint answers without a token, so a version is best-effort. */
export async function detectOmVersion(conn: OmConn): Promise<string | undefined> {
  const r = await omGet(conn, '/api/v1/system/version');
  if (!r.ok) return undefined;
  const v = (r.data as { version?: string })?.version;
  return v ? String(v) : undefined;
}

/** GET /api/v1/domains — OM domains (a discovery SIGNAL, not an authz boundary). */
export async function listOmDomains(conn: OmConn, limit = 50): Promise<OmRead<OmDomain[]>> {
  const r = await omGet(conn, `/api/v1/domains?limit=${limit}`);
  return r.ok ? { ok: true, data: shapeList(r.data) } : r;
}

/** GET /api/v1/dataProducts — OM data products. */
export async function listOmDataProducts(conn: OmConn, limit = 50): Promise<OmRead<OmDataProduct[]>> {
  const r = await omGet(conn, `/api/v1/dataProducts?limit=${limit}`);
  return r.ok ? { ok: true, data: shapeList(r.data) } : r;
}

/** GET /api/v1/tables (paged, fields=description,owners,tags) → CatalogAssets. */
export async function listOmTables(conn: OmConn, limit = 50): Promise<OmRead<CatalogAsset[]>> {
  const r = await omGet(conn, `/api/v1/tables?limit=${limit}&fields=description,owners,tags`);
  if (!r.ok) return r;
  const rows = (r.data as { data?: Record<string, unknown>[] })?.data;
  if (!Array.isArray(rows)) return { ok: false, reason: 'OpenMetadata returned no table list' };
  return {
    ok: true,
    data: rows.map((t) => ({
      name: String(t.name ?? ''),
      fqn: String(t.fullyQualifiedName ?? t.name ?? ''),
      description: String(t.description ?? ''),
      type: 'table',
      source: 'openmetadata' as const,
    })),
  };
}

/** GET /api/v1/search/query?q=... — free-text catalog search → CatalogAssets. */
export async function searchOmCatalog(conn: OmConn, query: string, limit = 25): Promise<OmRead<CatalogAsset[]>> {
  const r = await omGet(conn, `/api/v1/search/query?q=${encodeURIComponent(query)}&size=${limit}`);
  if (!r.ok) return r;
  // OM search returns Elasticsearch-shaped hits: { hits: { hits: [{ _source }] } }.
  const hits = (r.data as { hits?: { hits?: { _source?: Record<string, unknown> }[] } })?.hits?.hits;
  if (!Array.isArray(hits)) return { ok: true, data: [] };
  return {
    ok: true,
    data: hits.map((h) => {
      const s = h._source ?? {};
      return {
        name: String(s.name ?? ''),
        fqn: String(s.fullyQualifiedName ?? s.name ?? ''),
        description: String(s.description ?? ''),
        type: String(s.entityType ?? 'entity'),
        source: 'openmetadata' as const,
      };
    }),
  };
}

/** GET /api/v1/lineage/<entity>/name/<fqn> — read lineage for an OM entity. The
 *  raw upstream/downstream graph is returned as-is (read-only); the caller shapes
 *  it. `entity` defaults to `table`. Never throws — honest reason on failure. */
export async function getOmLineage(
  conn: OmConn,
  fqn: string,
  entity = 'table',
): Promise<OmRead<unknown>> {
  return omGet(conn, `/api/v1/lineage/${encodeURIComponent(entity)}/name/${encodeURIComponent(fqn)}`);
}

/**
 * The composed OpenMetadata source the Catalog assembler injects. Runs the health
 * probe first (always), then — only when connected AND a bot token is present —
 * pulls OM's tables to enrich the union. Every branch is HONEST and never throws:
 *   • unreachable        → reconnecting… (warn) — a transient fault, not "optional";
 *   • connected, no token → CONNECTED, governed marts mirrored (ok);
 *   • connected + token   → CONNECTED, N tables pulled (ok);
 *   • connected, pull fails → CONNECTED, sync degraded (ok — OM is still the backbone).
 */
export async function openMetadataSource(opts: {
  apiUrl: string;
  jwt?: string;
  fetchImpl: OmFetch;
  /** Governed marts this OS mirrors into OM — the count shown when we pull nothing. */
  mirroredMarts?: number;
  timeoutMs?: number;
}): Promise<OmSource> {
  const health = await openMetadataHealth(opts);
  const ver = health.version ? ` · v${health.version}` : '';

  if (!health.connected) {
    return {
      assets: null,
      ok: false,
      count: 0,
      connected: false,
      status: 'reconnecting to the catalog backbone…',
      severity: 'warn',
    };
  }

  const marts = opts.mirroredMarts ?? 0;
  const mirrored = marts > 0 ? ` · ${marts} governed mart${marts === 1 ? '' : 's'} mirrored` : '';

  // Connected but no bot token yet — OM is still the backbone; governed marts are
  // deep-linked into it. This is the state that replaces "optional · not connected".
  if (!opts.jwt) {
    return {
      assets: null,
      ok: true,
      count: marts,
      connected: true,
      version: health.version,
      status: `connected${ver}${mirrored}`,
      severity: 'ok',
    };
  }

  try {
    const assets = await fetchOpenMetadataTables({ ...opts, jwt: opts.jwt });
    return {
      assets,
      ok: true,
      count: assets.length,
      connected: true,
      version: health.version,
      status: `connected${ver} · ${assets.length} catalogued table${assets.length === 1 ? '' : 's'}`,
      severity: 'ok',
    };
  } catch {
    // OM answered the health probe but the authenticated pull failed (token/perms).
    // Still CONNECTED — report honestly without dropping OM to a fault.
    return {
      assets: null,
      ok: true,
      count: marts,
      connected: true,
      version: health.version,
      status: `connected${ver}${mirrored} · catalog sync degraded`,
      severity: 'ok',
    };
  }
}
