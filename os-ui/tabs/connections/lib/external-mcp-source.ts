/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        connections
 * FEATURE:    The Home chat's source of remote MCP tools: the user's own Notion MCP connections
 * USER STORY: As a user I want the chat to search and read my Notion as me, with my sign-in kept
 *             on the server and failures explained in plain language.
 * ARCHITECTURE:
 *   - Implements the kernel's `ExternalMcpSource` over Notion's official remote MCP server
 *     (`mcp.notion.com`, per-user OAuth) using the MCP client in `core/auth/notion-mcp.ts`:
 *     `tools/list` and `tools/call`, nothing re-implemented.
 *   - Lists only connections the caller can see; the token is resolved per call by
 *     `resolveNotionMcpSession` and never leaves this module. The endpoint is re-checked against
 *     the egress allowlist before every call.
 *   - Read or write: the server's own `readOnlyHint` annotation, or Notion's documented read tools
 *     (search and fetch, comments, users, teams, queries). Anything else is a write.
 *   - Importing this module registers the source with the kernel (the chat route imports it).
 */
import type { CurrentUser } from '@core/kernel/auth';
import { callNotionMcpTool, listNotionMcpToolDefs, type FetchFn, type McpToolDef } from '@core/auth/notion-mcp';
import { isEgressAllowed } from '@core/infra/secrets';
import {
  ExternalMcpError,
  registerExternalMcpSource,
  type ExternalCallResult,
  type ExternalConnection,
  type ExternalMcpSource,
  type ExternalToolDef,
} from '@core/runtime/external-mcp';
import { listConnectionsForUser, resolveNotionMcpSession } from '@tabs/connections/lib/store';

/** Notion MCP tools that only read (developers.notion.com/guides/mcp/tools-faqs). Anything not here is a write. */
export const NOTION_READ_TOOLS: ReadonlySet<string> = new Set([
  'notion-search', 'notion-fetch', 'notion-get-comments', 'notion-get-users', 'notion-get-teams', 'notion-get-self',
  'notion-query-data-sources', 'notion-query-meeting-notes', 'notion-get-file-download-urls',
]);

const TOOLS_TTL_MS = 5 * 60_000;

/** A transport or auth failure of the remote server, in the chat's typed words. */
export function mapRemoteError(e: unknown): ExternalMcpError {
  if (e instanceof ExternalMcpError) return e;
  const err = e as Error & { remoteStatus?: number; status?: number };
  if (err.remoteStatus === 401) return new ExternalMcpError('oauth_expired', 'Notion refused your sign-in.', 'Open the Connections tab and click Reconnect on this connection.');
  if (err.remoteStatus === 403) return new ExternalMcpError('no_access', 'Notion says your account may not do that.', 'Ask the workspace owner for access.');
  if (err.name === 'AbortError' || err.name === 'TypeError' || err.remoteStatus === undefined) {
    return new ExternalMcpError('mcp_unreachable', `Notion's MCP server could not be reached (${err.name === 'AbortError' ? 'timed out' : err.message}).`, 'Try again in a moment.');
  }
  return new ExternalMcpError('mcp_unreachable', `Notion's MCP server answered ${err.remoteStatus}.`, 'Try again in a moment.');
}

function toDef(t: McpToolDef): ExternalToolDef {
  return {
    name: t.name,
    description: t.description ?? t.name,
    inputSchema: { type: 'object', properties: {}, ...(t.inputSchema as object | undefined) } as ExternalToolDef['inputSchema'],
    readOnly: t.annotations?.readOnlyHint === true || NOTION_READ_TOOLS.has(t.name),
  };
}

export function createNotionMcpSource(opts: { fetchImpl?: FetchFn; now?: () => number } = {}): ExternalMcpSource {
  const cache = new Map<string, { at: number; tools: ExternalToolDef[] }>();
  const clock = opts.now ?? Date.now;

  async function session(user: CurrentUser, connId: string) {
    const s = await resolveNotionMcpSession(connId, user, { fetchImpl: opts.fetchImpl });
    const egress = isEgressAllowed(s.reg.mcpEndpoint);
    if (!egress.allowed) {
      throw new ExternalMcpError('policy_denied', `Calls to ${egress.host} are not on the egress allowlist.`, 'An administrator must approve the host first.');
    }
    return s;
  }

  return {
    async listConnections(user): Promise<ExternalConnection[]> {
      const all = await listConnectionsForUser(user);
      return all
        .filter((c) => c.template === 'notion-mcp' && c.health !== 'untested')
        .map((c) => ({
          id: c.id, name: c.name, provider: 'notion', owner: c.owner, principal: c.principal, domain: c.domain,
          visibility: c.visibility, auth: c.auth, archived: c.archived === true,
        }));
    },

    async listTools(user, connId) {
      const key = `${user.id}:${connId}`;
      const hit = cache.get(key);
      if (hit && clock() - hit.at < TOOLS_TTL_MS) return hit.tools;
      const { reg, accessToken } = await session(user, connId);
      try {
        const tools = (await listNotionMcpToolDefs(reg, accessToken, { fetchImpl: opts.fetchImpl })).map(toDef);
        cache.set(key, { at: clock(), tools });
        return tools;
      } catch (e) {
        throw mapRemoteError(e);
      }
    },

    async call(user, connId, tool, args): Promise<ExternalCallResult> {
      const { reg, accessToken } = await session(user, connId);
      try {
        const r = await callNotionMcpTool(reg, accessToken, tool, args, { fetchImpl: opts.fetchImpl });
        return {
          text: (r.content ?? []).map((c) => c.text ?? '').join('\n'),
          ...(r.structuredContent !== undefined ? { structured: r.structuredContent } : {}),
          isError: r.isError === true,
        };
      } catch (e) {
        throw mapRemoteError(e);
      }
    },
  };
}

registerExternalMcpSource(createNotionMcpSource());
