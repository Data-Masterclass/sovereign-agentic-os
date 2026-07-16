/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { Connection } from '@/lib/connections/schema';
import { getSecretServerSide } from '@/lib/infra/secrets';

/**
 * Microsoft Purview client over the account's Atlas/Purview REST API
 * (`https://<account>.purview.azure.com`) — the per-connection bridge to a
 * customer's data-governance catalog via a Microsoft OAuth 2.0 access token
 * (audience `https://purview.azure.net`).
 *
 * A governed, READ-ONLY catalog/lineage-governance connection: OS agents search
 * assets, read an entity, list classifications, and read lineage to answer "what
 * data do we have, how is it classified, and where does it flow" questions. There
 * are NO writes — mutating the catalog is out of scope for this connector.
 *
 * Its base URL differs from Microsoft Graph (it is the customer's Purview account
 * host, not `graph.microsoft.com`), so it does NOT reuse the Graph transport; it
 * has its own tiny bearer-send helper with the SAME discipline: `fetch` injected,
 * token injected as an arg (never logged/returned), every call NEVER throws —
 * `{ ok:false, reason }`; 401/403/404/429 mapped honestly. Egress: the subdomain
 * rule `purview.azure.com` covers `<account>.purview.azure.com`.
 */

export type PurviewFetch = typeof fetch;

export type PurviewConn = {
  baseUrl: string;
  token?: string;
  fetchImpl: PurviewFetch;
  timeoutMs?: number;
};

export type PurviewResult<T> =
  | { ok: true; data: T; truncated?: boolean }
  | { ok: false; reason: string };

const PAGE = 25;

export function purviewAuthHeaders(token?: string): Record<string, string> {
  const h: Record<string, string> = { accept: 'application/json' };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

function base(conn: PurviewConn): string {
  return (conn.baseUrl || '').replace(/\/$/, '');
}

async function send(
  conn: PurviewConn,
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>,
): Promise<PurviewResult<Record<string, unknown>>> {
  if (!base(conn)) return { ok: false, reason: 'no Purview account endpoint configured' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), conn.timeoutMs ?? 6000);
  try {
    const init: RequestInit = {
      method,
      headers: { ...purviewAuthHeaders(conn.token), ...(body ? { 'content-type': 'application/json' } : {}) },
      signal: ctrl.signal,
      cache: 'no-store',
    };
    if (body) init.body = JSON.stringify(body);
    const res = await conn.fetchImpl(`${base(conn)}${path}`, init);
    if (res.status === 429) return { ok: false, reason: `rate-limited; retry after ${res.headers.get('retry-after') ?? '30'}s` };
    if (res.status === 401) return { ok: false, reason: 'unauthorized (access token expired or invalid — refresh it)' };
    if (res.status === 403) return { ok: false, reason: 'forbidden (missing Purview data-reader role)' };
    if (res.status === 404) return { ok: false, reason: 'not_found' };
    if (!res.ok) return { ok: false, reason: `Purview ${res.status}` };
    if (res.status === 204) return { ok: true, data: {} };
    return { ok: true, data: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  } catch {
    return { ok: false, reason: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

// --------------------------------------------------------------- liveness -------

/**
 * Liveness: GET /catalog/api/atlas/v2/types/typedefs?type=classification — a cheap,
 * always-available metadata read. 2xx ⇒ live; 401 ⇒ honest ✗ (never fake green).
 */
export async function purviewHealth(conn: PurviewConn): Promise<{ connected: boolean; detail?: string; reason?: string }> {
  const r = await send(conn, 'GET', '/catalog/api/atlas/v2/types/typedefs?type=classification');
  if (r.ok) {
    const defs = Array.isArray(r.data.classificationDefs) ? (r.data.classificationDefs as unknown[]).length : 0;
    return { connected: true, detail: `catalog reachable (${defs} classification defs)` };
  }
  return { connected: false, reason: r.reason };
}

// ------------------------------------------------------------- reads (auto) -----

export type PurviewAsset = { guid: string; name: string; typeName: string; qualifiedName: string };
export type PurviewClassification = { name: string; description: string };
export type PurviewLineageEdge = { fromEntityId: string; toEntityId: string };

function shapeAsset(d: Record<string, unknown>): PurviewAsset {
  const attrs = (d.attributes ?? {}) as Record<string, unknown>;
  return {
    guid: String(d.guid ?? d.id ?? ''),
    name: String(d.name ?? attrs.name ?? ''),
    typeName: String(d.entityType ?? d.typeName ?? ''),
    qualifiedName: String(d.qualifiedName ?? attrs.qualifiedName ?? ''),
  };
}

/** POST /catalog/api/search/query — search the catalog for assets. Read. Bounded. */
export async function purviewSearchAssets(conn: PurviewConn, keywords: string): Promise<PurviewResult<PurviewAsset[]>> {
  if (!keywords.trim()) return { ok: false, reason: 'search_assets needs a keyword' };
  const r = await send(conn, 'POST', '/catalog/api/search/query?api-version=2023-09-01', { keywords, limit: PAGE });
  if (!r.ok) return r;
  const rows = Array.isArray(r.data.value) ? (r.data.value as Record<string, unknown>[]) : [];
  return { ok: true, data: rows.map(shapeAsset), truncated: rows.length >= PAGE };
}

/** GET /catalog/api/atlas/v2/entity/guid/{guid} — read one asset (entity). Read. */
export async function purviewGetAsset(conn: PurviewConn, guid: string): Promise<PurviewResult<PurviewAsset>> {
  if (!guid.trim()) return { ok: false, reason: 'get_asset needs an asset guid' };
  const r = await send(conn, 'GET', `/catalog/api/atlas/v2/entity/guid/${encodeURIComponent(guid)}`);
  if (!r.ok) return r;
  const entity = (r.data.entity ?? r.data) as Record<string, unknown>;
  return { ok: true, data: shapeAsset(entity) };
}

/** GET /catalog/api/atlas/v2/types/typedefs?type=classification — list classifications. Read. */
export async function purviewListClassifications(conn: PurviewConn): Promise<PurviewResult<PurviewClassification[]>> {
  const r = await send(conn, 'GET', '/catalog/api/atlas/v2/types/typedefs?type=classification');
  if (!r.ok) return r;
  const rows = Array.isArray(r.data.classificationDefs) ? (r.data.classificationDefs as Record<string, unknown>[]) : [];
  return { ok: true, data: rows.map((d) => ({ name: String(d.name ?? ''), description: String(d.description ?? '') })) };
}

/** GET /catalog/api/atlas/v2/lineage/{guid} — read the lineage graph for an asset. Read. */
export async function purviewGetLineage(conn: PurviewConn, guid: string): Promise<PurviewResult<PurviewLineageEdge[]>> {
  if (!guid.trim()) return { ok: false, reason: 'get_lineage needs an asset guid' };
  const r = await send(conn, 'GET', `/catalog/api/atlas/v2/lineage/${encodeURIComponent(guid)}?depth=1&direction=BOTH`);
  if (!r.ok) return r;
  const rels = Array.isArray(r.data.relations) ? (r.data.relations as Record<string, unknown>[]) : [];
  return {
    ok: true,
    data: rels.map((e) => ({ fromEntityId: String(e.fromEntityId ?? ''), toEntityId: String(e.toEntityId ?? '') })),
  };
}

// ------------------------------------------------------- server-side bridge -----

/** Build the pure Purview client config — the OAuth access token is dereferenced
 *  from the vault HERE (server-side) and never leaves this process. */
export function purviewConnFrom(c: Connection): PurviewConn {
  return {
    baseUrl: c.endpoint || '',
    token: getSecretServerSide(c.secretRef) ?? undefined,
    fetchImpl: fetch,
    timeoutMs: 6000,
  };
}
