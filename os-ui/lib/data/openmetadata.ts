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
  /** The OM build version (from `detectOmVersion`), recorded so the Phase-2 write
   *  helpers can REFUSE writes on an OM outside the tested range. Read-only paths
   *  ignore it. */
  omVersion?: string;
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

// ======================================================================
// PER-CONNECTION OpenMetadata WRITE helpers (Phase 2 — scoped write-back)
// ======================================================================
//
// Additive, integrity-safe write-back of OS-produced assets into a customer's
// existing OM. The seven guards from the approved design are implemented HERE
// (the low-level HTTP verbs) and in `lib/connections/openmetadata-sync.ts` (the
// plan/preview/apply engine). This module owns:
//   • the TESTED OM version range — every write REFUSES on an out-of-range OM;
//   • the JSON-Patch builder allowlist — ONLY `add`/`replace`/`test`, NEVER
//     `remove` (rejected at build time AND asserted in tests) [Guard 2];
//   • the low-level verbs `putOmEntity` / `patchOmEntity` / `putOmLineage` /
//     `createOmTestCaseResult`, all injectable-`fetch`, Bearer token, never-throw.
// Namespace isolation, managedBy stamping, idempotency, optimistic concurrency
// and dry-run live in the sync engine that composes these verbs.

/** The OM build range this write path has been TESTED against. A write REFUSES
 *  (fails closed) outside it — Guard: never write on an unknown OM shape. The
 *  range is deliberately wide across the 1.x line the read client already speaks;
 *  an operator widens it only after re-testing against a newer OM. */
export const TESTED_OM_MIN = '1.3.0';
export const TESTED_OM_MAX = '1.9.99';

/** Parse `1.5.3` (ignoring any `-SNAPSHOT`/build suffix) into a comparable tuple. */
function semver(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function cmp(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** True when `version` is within [TESTED_OM_MIN, TESTED_OM_MAX]. An unparseable
 *  or absent version is OUT of range (fail closed) — we never write blind. */
export function omVersionWritable(version?: string): boolean {
  if (!version) return false;
  const v = semver(version);
  if (!v) return false;
  return cmp(v, semver(TESTED_OM_MIN)!) >= 0 && cmp(v, semver(TESTED_OM_MAX)!) <= 0;
}

/** A single JSON-Patch operation. `test` is a fail-closed PRECONDITION (Guard 5):
 *  it asserts a path is absent/holds an expected value before the mutating ops
 *  apply — OM returns 412 and the whole patch is rejected if it does not hold. */
export type OmPatchOp =
  | { op: 'add'; path: string; value: unknown }
  | { op: 'replace'; path: string; value: unknown }
  | { op: 'test'; path: string; value?: unknown };

/**
 * Guard 2 — the ADDITIVE-ONLY JSON-Patch builder. This is the ONE place OS code
 * constructs a patch, and it structurally CANNOT emit a `remove` (the input type
 * has no such variant) — plus a defensive runtime reject so a cast-through `any`
 * still fails. Returns the ops unchanged when clean; THROWS on any `remove` or an
 * unknown op. Callers pass ONLY `add`/`replace` on OS-authored paths + `test`
 * preconditions; overwriting a human field is prevented by the caller pairing a
 * `test` (absent/empty) with each `replace`, never by this builder alone.
 */
export function buildAdditivePatch(ops: OmPatchOp[]): OmPatchOp[] {
  for (const op of ops) {
    const kind = (op as { op?: string }).op;
    if (kind !== 'add' && kind !== 'replace' && kind !== 'test') {
      throw new Error(`OM patch: only add/replace/test allowed, got "${String(kind)}" (no remove ever)`);
    }
  }
  return ops;
}

/** An OM write that never throws: either the created/updated body, or an honest
 *  reason. `conflict` is TRUE when OM rejected a JSON-Patch `test` precondition
 *  (412) — a human changed the field since our last sync, so we YIELDED. */
export type OmWrite<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; reason: string; conflict?: boolean };

async function omSend(
  conn: OmConn,
  method: 'PUT' | 'PATCH' | 'POST',
  path: string,
  body: unknown,
  contentType = 'application/json',
): Promise<OmWrite> {
  const base = conn.baseUrl.replace(/\/$/, '');
  try {
    const res = await withTimeout(
      conn.fetchImpl,
      `${base}${path}`,
      {
        method,
        headers: { ...authHeaders(conn.token), 'content-type': contentType },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      },
      conn.timeoutMs ?? 5000,
    );
    // 412 = a JSON-Patch `test` precondition failed → a human edited the field
    // since our last sync. We YIELD (never overwrite) and record the conflict.
    if (res.status === 412) return { ok: false, reason: 'precondition failed — human edit since last sync', conflict: true };
    if (!res.ok) return { ok: false, reason: `OpenMetadata ${res.status}` };
    // A 200/201 body is the entity; a 204 (or empty) is still a success (no-op PUT).
    try {
      return { ok: true, data: await res.json() };
    } catch {
      return { ok: true, data: null };
    }
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
}

/**
 * PUT create-or-update ONE OM entity. Used ONLY for OS-NAMESPACE entities (Guard 1
 * — the caller restricts `path` to the `sovereign_os` Service / the OS Domain).
 * OM's PUT is idempotent: the same body PUT twice is a no-op (Guard 4). The write
 * REFUSES (does not send) when the OM version is outside the tested range.
 */
export async function putOmEntity(conn: OmConn, path: string, body: unknown): Promise<OmWrite> {
  if (!omVersionWritable(conn.omVersion)) {
    return { ok: false, reason: `OM version ${conn.omVersion ?? 'unknown'} outside tested write range ${TESTED_OM_MIN}–${TESTED_OM_MAX}` };
  }
  return omSend(conn, 'PUT', path, body);
}

/**
 * PATCH one OM entity with an ADDITIVE JSON-Patch (Guard 2). The ops are run
 * through {@link buildAdditivePatch} so a `remove` can NEVER reach the wire; the
 * body is sent as `application/json-patch+json`. Include a `test` op to make the
 * patch fail-closed against a concurrent human edit (Guard 5). REFUSES outside
 * the tested OM version range.
 */
export async function patchOmEntity(conn: OmConn, entityPath: string, ops: OmPatchOp[]): Promise<OmWrite> {
  if (!omVersionWritable(conn.omVersion)) {
    return { ok: false, reason: `OM version ${conn.omVersion ?? 'unknown'} outside tested write range ${TESTED_OM_MIN}–${TESTED_OM_MAX}` };
  }
  let safe: OmPatchOp[];
  try {
    safe = buildAdditivePatch(ops);
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
  if (safe.length === 0) return { ok: true, data: null }; // nothing to change → no-op
  return omSend(conn, 'PATCH', entityPath, safe, 'application/json-patch+json');
}

/**
 * PUT one lineage EDGE (idempotent — Guard 4: the same edge PUT twice is a no-op
 * in OM). `fromId`/`toId` are OM entity ids; `entity` defaults to `table`. REFUSES
 * outside the tested OM version range. Additive by nature (adds an edge; removes
 * nothing).
 */
export async function putOmLineage(
  conn: OmConn,
  edge: { fromId: string; toId: string; fromEntity?: string; toEntity?: string },
): Promise<OmWrite> {
  if (!omVersionWritable(conn.omVersion)) {
    return { ok: false, reason: `OM version ${conn.omVersion ?? 'unknown'} outside tested write range ${TESTED_OM_MIN}–${TESTED_OM_MAX}` };
  }
  const body = {
    edge: {
      fromEntity: { id: edge.fromId, type: edge.fromEntity ?? 'table' },
      toEntity: { id: edge.toId, type: edge.toEntity ?? 'table' },
    },
  };
  return omSend(conn, 'PUT', '/api/v1/lineage', body);
}

/**
 * APPEND one test-case RESULT to an OS-authored test case (additive time series —
 * never mutates a definition). REFUSES outside the tested OM version range.
 */
export async function createOmTestCaseResult(
  conn: OmConn,
  testCaseFqn: string,
  result: { status: 'Success' | 'Failed' | 'Aborted'; result: string; timestamp?: number },
): Promise<OmWrite> {
  if (!omVersionWritable(conn.omVersion)) {
    return { ok: false, reason: `OM version ${conn.omVersion ?? 'unknown'} outside tested write range ${TESTED_OM_MIN}–${TESTED_OM_MAX}` };
  }
  const body = {
    testCaseStatus: result.status,
    result: result.result,
    timestamp: result.timestamp ?? Date.now(),
  };
  return omSend(conn, 'PUT', `/api/v1/dataQuality/testCases/${encodeURIComponent(testCaseFqn)}/testCaseResult`, body);
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
