/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    A test double of Notion's hosted MCP server
 * USER STORY: As a maintainer I want CI to prove the chat's Notion path without calling Notion.
 * ARCHITECTURE: a stub of Notion's hosted MCP server (Streamable HTTP, JSON replies) with Notion's tool names and
 * shapes for search, fetch and create-pages, plus the OAuth token endpoint. It is a test double for
 * CI, where no real Notion call is made; it records what it received so a test can prove the user's
 * token and arguments reached the remote server and nothing else did.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';

export type StubPage = { id: string; title: string; url: string; text: string; lastEdited: string; truncated?: boolean };

export type NotionStub = {
  base: string;
  /** Every tools/call it served: tool, arguments, and the bearer token it came with. */
  calls: { tool: string; args: Record<string, unknown>; token: string }[];
  writes: { tool: string; args: Record<string, unknown> }[];
  /** Behaviour switches a test flips. */
  mode: { down: boolean; unauthorized: boolean; refuseRefresh: boolean };
  pages: Map<string, StubPage>;
  refreshes: number;
  close(): Promise<void>;
};

const body = async (req: IncomingMessage): Promise<string> => {
  let s = '';
  for await (const c of req) s += c;
  return s;
};

export async function startNotionStub(pages: StubPage[], validTokens: string[] = ['AT']): Promise<NotionStub> {
  const stub: NotionStub = {
    base: '', calls: [], writes: [], pages: new Map(pages.map((p) => [p.id, p])),
    mode: { down: false, unauthorized: false, refuseRefresh: false }, refreshes: 0, close: async () => undefined,
  };
  const text = (t: string, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });
  const srv: Server = createServer(async (req, res) => {
    const raw = await body(req);
    if (stub.mode.down) return void req.socket.destroy();
    if (req.url === '/token') {
      if (stub.mode.refuseRefresh) { res.writeHead(400); return void res.end('{"error":"invalid_grant"}'); }
      stub.refreshes += 1;
      validTokens.push('AT-refreshed');
      res.writeHead(200, { 'content-type': 'application/json' });
      return void res.end(JSON.stringify({ access_token: 'AT-refreshed', expires_in: 3600 }));
    }
    const token = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1] ?? '';
    if (stub.mode.unauthorized || !validTokens.includes(token)) { res.writeHead(401); return void res.end('unauthorized'); }
    const msg = JSON.parse(raw) as { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    const reply = (result: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'stub-session' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    };
    if (msg.method === 'notifications/initialized') { res.writeHead(202); return void res.end(); }
    if (msg.method === 'initialize') return reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'notion-stub', version: '1' } });
    if (msg.method === 'tools/list') {
      const obj = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required });
      return reply({
        tools: [
          { name: 'notion-search', description: 'Search Notion pages and databases.', inputSchema: obj({ query: { type: 'string' } }, ['query']) },
          { name: 'notion-fetch', description: 'Fetch a page or database by URL or id.', inputSchema: obj({ id: { type: 'string' } }, ['id']) },
          { name: 'notion-create-pages', description: 'Create pages.', inputSchema: obj({ pages: { type: 'array' } }, ['pages']) },
        ],
      });
    }
    if (msg.method === 'tools/call') {
      const tool = String(msg.params?.name);
      const args = msg.params?.arguments ?? {};
      stub.calls.push({ tool, args, token });
      if (tool === 'notion-search') {
        const q = String(args.query ?? '').toLowerCase();
        const results = [...stub.pages.values()].filter((p) => p.title.toLowerCase().includes(q)).map((p) => ({ id: p.id, title: p.title, url: p.url, timestamp: p.lastEdited }));
        return reply(text(JSON.stringify({ type: 'workspace_search', results })));
      }
      if (tool === 'notion-fetch') {
        const p = stub.pages.get(String(args.id));
        if (!p) return reply(text('object_not_found: Could not find page. Make sure the page is shared with your integration.', true));
        return reply(text(JSON.stringify({ title: p.title, url: p.url, text: p.text, page_last_edited_at: p.lastEdited, ...(p.truncated ? { truncated: true } : {}) })));
      }
      if (tool === 'notion-create-pages') { stub.writes.push({ tool, args }); return reply(text('{"created":1}')); }
      return reply(text(`unknown tool ${tool}`, true));
    }
    res.writeHead(400); res.end();
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  stub.base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  stub.close = () => new Promise((r) => srv.close(() => r()));
  return stub;
}

const nativeFetch = globalThis.fetch; // captured at import: a test may replace the global afterwards

/** A fetch that sends Notion's real endpoints to the stub (the egress allowlist still sees mcp.notion.com). */
export function fetchToStub(stub: Pick<NotionStub, 'base'>): typeof fetch {
  return ((url: RequestInfo | URL, init?: RequestInit) =>
    nativeFetch(String(url).replace('https://mcp.notion.com', stub.base), init)) as typeof fetch;
}
