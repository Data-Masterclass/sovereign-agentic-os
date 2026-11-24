/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        connections
 * FEATURE:    The Home chat's source of account tools: Notion (remote MCP), Microsoft 365, OneDrive, Google Drive
 * USER STORY: As a user I want the chat to search and read my Notion, my mail, calendar, Teams and files
 *             as ME, with my own sign-in kept on the server, a "Connect your account" button when I have
 *             not connected yet, and failures explained in plain language.
 * ARCHITECTURE:
 *   - Implements the kernel's `ExternalMcpSource` for every account connection the caller can see:
 *     Notion over its official remote MCP server (`core/auth/notion-mcp.ts`: tools/list, tools/call),
 *     Microsoft 365 / OneDrive / Google Drive over the OS's governed tools (`account-tools.ts`).
 *   - Credentials: `resolveAccountSession` (store) picks the credential by the connection's mode —
 *     the caller's OWN sign-in (per_user, never anyone else's), the shared one, or the owner's (legacy).
 *     The token never leaves this module. The endpoint is checked against the egress allowlist.
 *   - A per-user connection the caller has not connected yet still offers its tools (Notion: search and
 *     fetch); a call answers `needs_connect`, and the chat shows the Connect button for that connection.
 *   - Every call is audited with the acting user, the credential mode and the credential subject.
 *   - Importing this module registers the source with the kernel (the chat route imports it).
 */
import type { CurrentUser } from '@core/kernel/auth';
import { config } from '@core/kernel/config';
import { callNotionMcpTool, listNotionMcpToolDefs, type FetchFn, type McpToolDef } from '@core/auth/notion-mcp';
import { isEgressAllowed } from '@core/infra/secrets';
import {
  ExternalMcpError,
  registerExternalMcpSource,
  type ExternalCallResult,
  type ExternalConnection,
  type ExternalMcpSource,
  type ExternalTable,
  type ExternalToolDef,
} from '@core/runtime/external-mcp';
import {
  listConnectionsForUser,
  resolveAccountSession,
  traceAccountRead,
  effectiveCredentialMode,
  accountLabel,
  type AccountSession,
  type AccountRefreshFn,
} from '@tabs/connections/lib/store';
import type { Connection } from '@tabs/connections/lib/schema';
import { accountProviderForTemplate, accountToolDefs, callAccountTool, readAccountTable, AccountApiError, type AccountProvider } from '@tabs/connections/lib/account-tools';
import { tableToCsv, OfficeExtractError } from '@tabs/connections/lib/office-extract';

/** Notion MCP tools that only read (developers.notion.com/guides/mcp/tools-faqs). Anything not here is a write. */
export const NOTION_READ_TOOLS: ReadonlySet<string> = new Set([
  'notion-search', 'notion-fetch', 'notion-get-comments', 'notion-get-users', 'notion-get-teams', 'notion-get-self',
  'notion-query-data-sources', 'notion-query-meeting-notes', 'notion-get-file-download-urls',
]);

/** What a not-yet-connected Notion connection offers, so a call can answer `needs_connect`. */
const NOTION_PLACEHOLDER_TOOLS: ExternalToolDef[] = [
  { name: 'notion-search', description: 'Search the user\'s Notion workspace (needs the user\'s Notion sign-in).', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } as ExternalToolDef['inputSchema'], readOnly: true },
  { name: 'notion-fetch', description: 'Fetch one Notion page by id or URL (needs the user\'s Notion sign-in).', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } as ExternalToolDef['inputSchema'], readOnly: true },
];

const TOOLS_TTL_MS = 5 * 60_000;

/** The wire provider key of a connection (part of the chat tool name). */
export function wireProvider(c: Pick<Connection, 'template'>): string | null {
  if (c.template === 'notion-mcp') return 'notion';
  return accountProviderForTemplate(c.template);
}

/** A transport or auth failure of the remote server, in the chat's typed words. */
export function mapRemoteError(e: unknown, label = 'Notion'): ExternalMcpError {
  if (e instanceof ExternalMcpError) return e;
  if (e instanceof OfficeExtractError) return new ExternalMcpError('tool_error', e.message, 'Pick another file or sheet.');
  const err = e as Error & { remoteStatus?: number; status?: number };
  if (err.remoteStatus === 401) return new ExternalMcpError('needs_connect', `${label} refused your sign-in.`, `Click "Connect your ${label} account" to sign in again.`);
  if (err.remoteStatus === 403) return new ExternalMcpError('no_access', `${label} says your account may not do that.`, 'Ask the owner of the item, or your administrator (some Microsoft scopes need admin consent).');
  if (err.remoteStatus === 404) return new ExternalMcpError('no_access', `${label} found no such item, or your account cannot see it.`, 'Check the id, or search again.');
  if (err.remoteStatus === 413) return new ExternalMcpError('too_large', err.message, 'Pick a smaller file, or sync the drive to Files.');
  if (err.name === 'AbortError' || err.name === 'TypeError' || err.remoteStatus === undefined) {
    return new ExternalMcpError('mcp_unreachable', `${label} could not be reached (${err.name === 'AbortError' ? 'timed out' : err.message}).`, 'Try again in a moment.');
  }
  return new ExternalMcpError('mcp_unreachable', `${label} answered ${err.remoteStatus}.`, 'Try again in a moment.');
}

function toDef(t: McpToolDef): ExternalToolDef {
  return {
    name: t.name,
    description: t.description ?? t.name,
    inputSchema: { type: 'object', properties: {}, ...(t.inputSchema as object | undefined) } as ExternalToolDef['inputSchema'],
    readOnly: t.annotations?.readOnlyHint === true || NOTION_READ_TOOLS.has(t.name),
  };
}

function endpointOf(c: Connection, s: AccountSession): string {
  if (c.template === 'notion-mcp') return s.reg?.mcpEndpoint ?? c.endpoint;
  return c.template === 'gdrive' ? config.googleApiBase : config.graphApiBase;
}

/** Is this connection one the chat offers to `user`? */
function chatUsable(c: Connection, user: CurrentUser): boolean {
  if (!wireProvider(c) || c.archived) return false;
  const mode = effectiveCredentialMode(c);
  if (mode === 'per_user' || mode === 'shared') return true;
  // Legacy (owner's token): only once connected, only for the owner (OPA says the same).
  return c.owner === user.id && c.health !== 'untested';
}

export function createAccountSource(opts: { fetchImpl?: FetchFn; now?: () => number; refresh?: AccountRefreshFn } = {}): ExternalMcpSource {
  const cache = new Map<string, { at: number; tools: ExternalToolDef[] }>();
  const clock = opts.now ?? Date.now;

  async function session(user: CurrentUser, connId: string): Promise<AccountSession> {
    const s = await resolveAccountSession(connId, user, { fetchImpl: opts.fetchImpl, ...(opts.refresh ? { refresh: opts.refresh } : {}) });
    const egress = isEgressAllowed(endpointOf(s.connection, s));
    if (!egress.allowed) {
      throw new ExternalMcpError('policy_denied', `Calls to ${egress.host} are not on the egress allowlist.`, 'An administrator must approve the host first.');
    }
    return s;
  }

  async function connectionOf(user: CurrentUser, connId: string): Promise<Connection> {
    const c = (await listConnectionsForUser(user)).find((x) => x.id === connId);
    if (!c || !chatUsable(c, user)) throw new ExternalMcpError('unknown_connection', 'That connection is not yours to use.', 'Check the Connections tab.');
    return c;
  }

  return {
    async listConnections(user): Promise<ExternalConnection[]> {
      const all = await listConnectionsForUser(user);
      return all
        .filter((c) => chatUsable(c, user))
        .map((c) => ({
          id: c.id, name: c.name, provider: wireProvider(c)!, owner: c.owner, principal: c.principal, domain: c.domain,
          visibility: c.visibility, auth: c.auth, archived: c.archived === true,
          ...(c.credentialMode ? { credentialMode: c.credentialMode } : {}),
          ...(c.template !== 'notion-mcp' ? { tables: true } : {}),
        }));
    },

    async listTools(user, connId) {
      const c = await connectionOf(user, connId);
      const p = accountProviderForTemplate(c.template);
      if (p) return accountToolDefs(p);
      // Notion: the server's own tool list, with the caller's credential.
      const key = `${user.id}:${connId}`;
      const hit = cache.get(key);
      if (hit && clock() - hit.at < TOOLS_TTL_MS) return hit.tools;
      let s: AccountSession;
      try {
        s = await session(user, connId);
      } catch (e) {
        if (e instanceof ExternalMcpError && e.code === 'needs_connect') return NOTION_PLACEHOLDER_TOOLS.map((t) => ({ ...t }));
        throw e;
      }
      try {
        const tools = (await listNotionMcpToolDefs(s.reg!, s.accessToken, { fetchImpl: opts.fetchImpl })).map(toDef);
        cache.set(key, { at: clock(), tools });
        return tools;
      } catch (e) {
        throw mapRemoteError(e);
      }
    },

    async call(user, connId, tool, args): Promise<ExternalCallResult> {
      const s = await session(user, connId);
      const c = s.connection;
      const label = accountLabel(c);
      try {
        const p = accountProviderForTemplate(c.template);
        let r: ExternalCallResult;
        if (p) r = await callAccountTool(p, s.accessToken, tool, args, { fetchImpl: opts.fetchImpl });
        else {
          if (!s.reg) throw new ExternalMcpError('needs_connect', 'Notion is not connected yet.', 'Click "Connect your Notion account".');
          const m = await callNotionMcpTool(s.reg, s.accessToken, tool, args, { fetchImpl: opts.fetchImpl });
          r = {
            text: (m.content ?? []).map((x) => x.text ?? '').join('\n'),
            ...(m.structuredContent !== undefined ? { structured: m.structuredContent } : {}),
            isError: m.isError === true,
          };
        }
        // `callExternal` writes the one trace of this call; it takes whose credential ran from here.
        return { ...r, credentialSubject: s.credentialSubject };
      } catch (e) {
        throw mapRemoteError(e, label);
      }
    },

    async readTable(user, connId, input): Promise<ExternalTable> {
      const s = await session(user, connId);
      const p: AccountProvider | null = accountProviderForTemplate(s.connection.template);
      if (!p) throw new ExternalMcpError('unknown_tool', 'This connection cannot read spreadsheets.', 'Use Microsoft 365, OneDrive or Google Drive.');
      try {
        const t = await readAccountTable(p, s.accessToken, input, { fetchImpl: opts.fetchImpl });
        const out = tableToCsv(t.columns, t.rows, input.maxBytes);
        traceAccountRead(s, user, 'read_table', { ok: true, rows: out.rows });
        return {
          fileName: t.fileName, fileId: t.fileId, url: t.url, sheet: t.sheet, sheetNames: t.sheetNames, columns: t.columns,
          csv: out.csv, rows: out.rows, totalRows: t.totalRows, truncated: out.truncated || t.truncated, preview: t.rows.slice(0, 10),
        };
      } catch (e) {
        traceAccountRead(s, user, 'read_table', { ok: false, error: (e as Error)?.message ?? String(e) });
        throw mapRemoteError(e, accountLabel(s.connection));
      }
    },
  };
}

/** Kept for the Notion tests and callers of the earlier name. */
export const createNotionMcpSource = createAccountSource;

export { AccountApiError };

registerExternalMcpSource(createAccountSource());
