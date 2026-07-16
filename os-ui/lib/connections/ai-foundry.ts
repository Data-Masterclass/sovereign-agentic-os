/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { Connection } from '@/lib/connections/schema';
import { getSecretServerSide } from '@/lib/infra/secrets';

/**
 * Azure AI Foundry / Azure AI (Azure ML) client — the per-connection bridge to a
 * customer's Azure ML workspace via a Microsoft OAuth 2.0 access token (audience
 * `https://ml.azure.com`).
 *
 * A governed, READ-ONLY ML-metadata connection: OS agents list registered models,
 * list deployments, and read one deployment to answer "what models / endpoints do
 * we run" questions. There are NO writes — deploying or deleting a model is out of
 * scope for this connector.
 *
 * The base is the workspace/region data-plane host the customer supplies
 * (`https://<region>.api.azureml.ms`). It has its own tiny bearer-send helper with
 * the SAME discipline as the other hand-built clients: `fetch` injected, token
 * injected as an arg (never logged/returned), every call NEVER throws —
 * `{ ok:false, reason }`; 401/403/404/429 mapped honestly.
 *
 * HONEST LIMIT: the exact Azure ML data-plane list routes are workspace-scoped and
 * only verifiable against a live workspace — see `liveVerificationRequired` in the
 * install guide. The response shaping tolerates the two shapes the API returns
 * (`value: [...]` vs a bare array) so a live workspace flows through; a wrong route
 * degrades to an honest ✗ rather than fabricating rows. Egress: add
 * `<region>.api.azureml.ms` (subdomain rule `api.azureml.ms`) + `ml.azure.com`.
 */

export type AiFoundryFetch = typeof fetch;

export type AiFoundryConn = {
  baseUrl: string;
  token?: string;
  fetchImpl: AiFoundryFetch;
  timeoutMs?: number;
};

export type AiFoundryResult<T> =
  | { ok: true; data: T; truncated?: boolean }
  | { ok: false; reason: string };

const PAGE = 25;

export function aiFoundryAuthHeaders(token?: string): Record<string, string> {
  const h: Record<string, string> = { accept: 'application/json' };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

function base(conn: AiFoundryConn): string {
  return (conn.baseUrl || '').replace(/\/$/, '');
}

async function send(conn: AiFoundryConn, path: string): Promise<AiFoundryResult<Record<string, unknown>>> {
  if (!base(conn)) return { ok: false, reason: 'no Azure ML workspace endpoint configured' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), conn.timeoutMs ?? 6000);
  try {
    const res = await conn.fetchImpl(`${base(conn)}${path}`, {
      method: 'GET',
      headers: aiFoundryAuthHeaders(conn.token),
      signal: ctrl.signal,
      cache: 'no-store',
    });
    if (res.status === 429) return { ok: false, reason: `rate-limited; retry after ${res.headers.get('retry-after') ?? '30'}s` };
    if (res.status === 401) return { ok: false, reason: 'unauthorized (access token expired or invalid — refresh it)' };
    if (res.status === 403) return { ok: false, reason: 'forbidden (missing Azure ML reader role)' };
    if (res.status === 404) return { ok: false, reason: 'not_found' };
    if (!res.ok) return { ok: false, reason: `Azure ML ${res.status}` };
    return { ok: true, data: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  } catch {
    return { ok: false, reason: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

/** Tolerate `{ value: [...] }` and a bare array; return `[]` for neither. */
function rowsOf(d: Record<string, unknown>): Record<string, unknown>[] {
  if (Array.isArray(d.value)) return d.value as Record<string, unknown>[];
  if (Array.isArray(d)) return d as unknown as Record<string, unknown>[];
  return [];
}

// --------------------------------------------------------------- liveness -------

/** Liveness: list models (a cheap workspace read). 2xx ⇒ live; 401 ⇒ honest ✗. */
export async function aiFoundryHealth(conn: AiFoundryConn): Promise<{ connected: boolean; detail?: string; reason?: string }> {
  const r = await send(conn, '/modelregistry/v1.0/models?$top=1');
  if (r.ok) return { connected: true, detail: 'workspace reachable' };
  return { connected: false, reason: r.reason };
}

// ------------------------------------------------------------- reads (auto) -----

export type AiFoundryModel = { name: string; version: string; id: string };
export type AiFoundryDeployment = { name: string; model: string; provisioningState: string };

/** GET model registry — list registered models. Read. Bounded. */
export async function aiFoundryListModels(conn: AiFoundryConn): Promise<AiFoundryResult<AiFoundryModel[]>> {
  const r = await send(conn, `/modelregistry/v1.0/models?$top=${PAGE}`);
  if (!r.ok) return r;
  const rows = rowsOf(r.data);
  return {
    ok: true,
    data: rows.map((d) => ({ name: String(d.name ?? ''), version: String(d.version ?? ''), id: String(d.id ?? '') })),
    truncated: Boolean(r.data.nextLink ?? r.data['@odata.nextLink']),
  };
}

/** GET online deployments — list deployments. Read. Bounded. */
export async function aiFoundryListDeployments(conn: AiFoundryConn): Promise<AiFoundryResult<AiFoundryDeployment[]>> {
  const r = await send(conn, `/modelmanagement/v1.0/onlineDeployments?$top=${PAGE}`);
  if (!r.ok) return r;
  const rows = rowsOf(r.data);
  return {
    ok: true,
    data: rows.map((d) => {
      const props = (d.properties ?? {}) as Record<string, unknown>;
      return { name: String(d.name ?? ''), model: String(props.model ?? d.model ?? ''), provisioningState: String(props.provisioningState ?? '') };
    }),
    truncated: Boolean(r.data.nextLink ?? r.data['@odata.nextLink']),
  };
}

/** GET one online deployment by name. Read. */
export async function aiFoundryGetDeployment(conn: AiFoundryConn, name: string): Promise<AiFoundryResult<AiFoundryDeployment>> {
  if (!name.trim()) return { ok: false, reason: 'get_deployment needs a deployment name' };
  const r = await send(conn, `/modelmanagement/v1.0/onlineDeployments/${encodeURIComponent(name)}`);
  if (!r.ok) return r;
  const props = (r.data.properties ?? {}) as Record<string, unknown>;
  return { ok: true, data: { name: String(r.data.name ?? name), model: String(props.model ?? r.data.model ?? ''), provisioningState: String(props.provisioningState ?? '') } };
}

// ------------------------------------------------------- server-side bridge -----

/** Build the pure Azure ML client config — the OAuth access token is dereferenced
 *  from the vault HERE (server-side) and never leaves this process. */
export function aiFoundryConnFrom(c: Connection): AiFoundryConn {
  return {
    baseUrl: c.endpoint || '',
    token: getSecretServerSide(c.secretRef) ?? undefined,
    fetchImpl: fetch,
    timeoutMs: 6000,
  };
}
