/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { Connection } from '@/lib/connections/schema';
import { getSecretServerSide } from '@/lib/infra/secrets';
import { type GraphConn, GRAPH_API, GRAPH_PAGE, graphSend, type GraphResult } from '@/lib/connections/outlook';

/**
 * Microsoft Teams client over Microsoft Graph (`https://graph.microsoft.com/v1.0`) —
 * the per-connection bridge to a customer's Teams via a Microsoft OAuth 2.0 access
 * token.
 *
 * A governed OUTBOUND connection: OS agents read teams/channels/messages and
 * (approval-gated) post a channel message through the SAME capability gate. This is
 * its own module (one module per service, CONNECTOR-STANDARD §1.1) but reuses the
 * generic Microsoft Graph transport primitives from `outlook.ts` (`graphSend`,
 * headers, timeout, honest error mapping) rather than duplicating them. Teams-specific
 * SHAPING lives here.
 *
 * Same discipline: every call NEVER throws — `{ ok:false, reason }`; a short-lived
 * token that 401s is surfaced honestly; refresh-token rotation is a documented follow-up.
 */

export type { GraphConn } from '@/lib/connections/outlook';

export type TeamsResult<T> = GraphResult<T>;

// ------------------------------------------------------------- liveness -------

/** Liveness: GET /me. 2xx ⇒ live; 401 ⇒ honest ✗ (never fake green). */
export async function teamsHealth(conn: GraphConn): Promise<{ connected: boolean; detail?: string; reason?: string }> {
  const r = await graphSend(conn, 'GET', '/me');
  if (r.ok) {
    const who = String(r.data.userPrincipalName ?? r.data.displayName ?? '');
    return { connected: true, detail: who ? `signed in as ${who}` : undefined };
  }
  return { connected: false, reason: r.reason };
}

// ------------------------------------------------------------- reads (auto) -----

export type TeamRef = { id: string; displayName: string };
export type ChannelRef = { id: string; displayName: string };
export type ChannelMessage = { id: string; from: string; text: string; created: string };

/** GET /me/joinedTeams — list the teams the user is a member of. Read. */
export async function teamsListTeams(conn: GraphConn): Promise<TeamsResult<TeamRef[]>> {
  const r = await graphSend(conn, 'GET', `/me/joinedTeams?$top=${GRAPH_PAGE}`);
  if (!r.ok) return r;
  const rows = Array.isArray(r.data.value) ? (r.data.value as Record<string, unknown>[]) : [];
  return { ok: true, data: rows.map((d) => ({ id: String(d.id ?? ''), displayName: String(d.displayName ?? '') })), truncated: Boolean(r.data['@odata.nextLink']) };
}

/** GET /teams/{teamId}/channels — list channels in a team. Read. */
export async function teamsListChannels(conn: GraphConn, teamId: string): Promise<TeamsResult<ChannelRef[]>> {
  if (!teamId.trim()) return { ok: false, reason: 'list_channels needs a teamId' };
  const r = await graphSend(conn, 'GET', `/teams/${encodeURIComponent(teamId)}/channels`);
  if (!r.ok) return r;
  const rows = Array.isArray(r.data.value) ? (r.data.value as Record<string, unknown>[]) : [];
  return { ok: true, data: rows.map((d) => ({ id: String(d.id ?? ''), displayName: String(d.displayName ?? '') })) };
}

/** GET /teams/{teamId}/channels/{channelId}/messages — read recent channel messages. Read. */
export async function teamsListChannelMessages(conn: GraphConn, teamId: string, channelId: string): Promise<TeamsResult<ChannelMessage[]>> {
  if (!teamId.trim() || !channelId.trim()) return { ok: false, reason: 'list_channel_messages needs a teamId and a channelId' };
  const r = await graphSend(conn, 'GET', `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages?$top=${GRAPH_PAGE}`);
  if (!r.ok) return r;
  const rows = Array.isArray(r.data.value) ? (r.data.value as Record<string, unknown>[]) : [];
  return {
    ok: true,
    data: rows.map((d) => {
      const fromUser = ((d.from ?? {}) as { user?: { displayName?: string } }).user;
      const body = (d.body ?? {}) as { content?: string };
      return { id: String(d.id ?? ''), from: String(fromUser?.displayName ?? ''), text: String(body.content ?? ''), created: String(d.createdDateTime ?? '') };
    }),
    truncated: Boolean(r.data['@odata.nextLink']),
  };
}

// ---------------------------------------------- writes (Write-approval) ---------

/**
 * POST /teams/{teamId}/channels/{channelId}/messages — post a channel message.
 * Write — Write-approval upstream; never auto-posted. Never throws.
 */
export async function teamsPostChannelMessage(conn: GraphConn, teamId: string, channelId: string, text: string): Promise<TeamsResult<{ id: string }>> {
  if (!teamId.trim() || !channelId.trim()) return { ok: false, reason: 'post_channel_message needs a teamId and a channelId' };
  if (!text.trim()) return { ok: false, reason: 'post_channel_message needs text' };
  const r = await graphSend(conn, 'POST', `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages`, { body: { content: text } });
  if (!r.ok) return r;
  return { ok: true, data: { id: String(r.data.id ?? '') } };
}

// ------------------------------------------------------- server-side bridge -----

/** Build the pure Graph client config for Teams — the OAuth access token is
 *  dereferenced from the vault HERE (server-side) and never leaves this process. */
export function teamsConnFrom(c: Connection): GraphConn {
  return {
    baseUrl: c.endpoint || GRAPH_API,
    token: getSecretServerSide(c.secretRef) ?? undefined,
    fetchImpl: fetch,
    timeoutMs: 6000,
  };
}
