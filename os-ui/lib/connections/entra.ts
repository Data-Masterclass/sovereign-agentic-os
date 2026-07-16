/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { Connection } from '@/lib/connections/schema';
import { getSecretServerSide } from '@/lib/infra/secrets';
import { type GraphConn, GRAPH_API, GRAPH_PAGE, graphSend, type GraphResult } from '@/lib/connections/outlook';

/**
 * Microsoft Entra ID (Azure AD) client over Microsoft Graph
 * (`https://graph.microsoft.com/v1.0`) — the per-connection bridge to a customer's
 * directory via a Microsoft OAuth 2.0 access token.
 *
 * A governed, READ-ONLY identity/directory-governance connection: OS agents read
 * users, groups, and directory-role assignments to answer "who has access to what"
 * questions. There are NO writes — mutating a directory is out of scope for this
 * connector (an Admin override + a purpose-built write connector would be the honest
 * way to add one later), so the safe preset ships reads only.
 *
 * This is its own module (one module per service, CONNECTOR-STANDARD §1.1) but
 * reuses the generic Microsoft Graph transport primitives from `outlook.ts`
 * (`graphSend`, headers, timeout, honest 401/403/404/429 mapping) rather than
 * duplicating them. Entra-specific SHAPING lives here.
 *
 * Same discipline: every call NEVER throws — `{ ok:false, reason }`; a short-lived
 * token that 401s is surfaced honestly; refresh-token rotation is a documented
 * follow-up. Egress: `graph.microsoft.com` + `login.microsoftonline.com` are ALREADY
 * on the allowlist (added for OneDrive/Outlook/Teams) — no new host is needed.
 */

export type { GraphConn } from '@/lib/connections/outlook';

export type EntraResult<T> = GraphResult<T>;

// ------------------------------------------------------------- liveness -------

/** Liveness: GET /me. 2xx ⇒ live; 401 ⇒ honest ✗ (never fake green). */
export async function entraHealth(conn: GraphConn): Promise<{ connected: boolean; detail?: string; reason?: string }> {
  const r = await graphSend(conn, 'GET', '/me');
  if (r.ok) {
    const who = String(r.data.userPrincipalName ?? r.data.displayName ?? '');
    return { connected: true, detail: who ? `signed in as ${who}` : undefined };
  }
  return { connected: false, reason: r.reason };
}

// ------------------------------------------------------------- reads (auto) -----

export type EntraUser = { id: string; displayName: string; userPrincipalName: string; mail: string };
export type EntraGroup = { id: string; displayName: string; description: string };
export type EntraRoleAssignment = { id: string; principalId: string; roleDefinitionId: string; directoryScopeId: string };

function shapeUser(d: Record<string, unknown>): EntraUser {
  return {
    id: String(d.id ?? ''),
    displayName: String(d.displayName ?? ''),
    userPrincipalName: String(d.userPrincipalName ?? ''),
    mail: String(d.mail ?? ''),
  };
}

/** GET /users — list directory users (optionally $search). Read. Bounded. */
export async function entraListUsers(conn: GraphConn, opts?: { search?: string }): Promise<EntraResult<EntraUser[]>> {
  const params: Record<string, string> = { $top: String(GRAPH_PAGE), $select: 'id,displayName,userPrincipalName,mail' };
  if (opts?.search?.trim()) params.$search = `"displayName:${opts.search}"`;
  const qs = new URLSearchParams(params).toString();
  // $search on the directory requires the ConsistencyLevel=eventual header.
  const path = `/users?${qs}`;
  const r = opts?.search?.trim()
    ? await graphSendEventual(conn, path)
    : await graphSend(conn, 'GET', path);
  if (!r.ok) return r;
  const rows = Array.isArray(r.data.value) ? (r.data.value as Record<string, unknown>[]) : [];
  return { ok: true, data: rows.map(shapeUser), truncated: Boolean(r.data['@odata.nextLink']) };
}

/** GET /users/{id} — read one directory user. Read. */
export async function entraGetUser(conn: GraphConn, id: string): Promise<EntraResult<EntraUser>> {
  if (!id.trim()) return { ok: false, reason: 'get_user needs a user id (or userPrincipalName)' };
  const r = await graphSend(conn, 'GET', `/users/${encodeURIComponent(id)}?$select=id,displayName,userPrincipalName,mail`);
  if (!r.ok) return r;
  return { ok: true, data: shapeUser(r.data) };
}

/** GET /groups — list directory groups. Read. Bounded. */
export async function entraListGroups(conn: GraphConn): Promise<EntraResult<EntraGroup[]>> {
  const qs = new URLSearchParams({ $top: String(GRAPH_PAGE), $select: 'id,displayName,description' }).toString();
  const r = await graphSend(conn, 'GET', `/groups?${qs}`);
  if (!r.ok) return r;
  const rows = Array.isArray(r.data.value) ? (r.data.value as Record<string, unknown>[]) : [];
  return {
    ok: true,
    data: rows.map((d) => ({ id: String(d.id ?? ''), displayName: String(d.displayName ?? ''), description: String(d.description ?? '') })),
    truncated: Boolean(r.data['@odata.nextLink']),
  };
}

/**
 * GET /roleManagement/directory/roleAssignments — list directory-role assignments
 * (who holds which directory role, e.g. Global Administrator). Read. Governance-grade
 * directory metadata. Bounded.
 */
export async function entraListRoleAssignments(conn: GraphConn): Promise<EntraResult<EntraRoleAssignment[]>> {
  const r = await graphSend(conn, 'GET', `/roleManagement/directory/roleAssignments?$top=${GRAPH_PAGE}`);
  if (!r.ok) return r;
  const rows = Array.isArray(r.data.value) ? (r.data.value as Record<string, unknown>[]) : [];
  return {
    ok: true,
    data: rows.map((d) => ({
      id: String(d.id ?? ''),
      principalId: String(d.principalId ?? ''),
      roleDefinitionId: String(d.roleDefinitionId ?? ''),
      directoryScopeId: String(d.directoryScopeId ?? ''),
    })),
    truncated: Boolean(r.data['@odata.nextLink']),
  };
}

// A directory $search call needs ConsistencyLevel=eventual. We layer that header
// on top of the shared transport without duplicating it: a tiny wrapper conn whose
// fetchImpl injects the extra header, then delegate to graphSend.
async function graphSendEventual(conn: GraphConn, path: string): Promise<GraphResult<Record<string, unknown>>> {
  const wrapped: GraphConn = {
    ...conn,
    fetchImpl: ((url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set('ConsistencyLevel', 'eventual');
      return conn.fetchImpl(url, { ...init, headers });
    }) as typeof fetch,
  };
  return graphSend(wrapped, 'GET', path);
}

// ------------------------------------------------------- server-side bridge -----

/** Build the pure Graph client config for Entra — the OAuth access token is
 *  dereferenced from the vault HERE (server-side) and never leaves this process. */
export function entraConnFrom(c: Connection): GraphConn {
  return {
    baseUrl: c.endpoint || GRAPH_API,
    token: getSecretServerSide(c.secretRef) ?? undefined,
    fetchImpl: fetch,
    timeoutMs: 6000,
  };
}
