/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { NextResponse } from 'next/server';
import { resolveMcpUser } from '@core/mcp/token';
import { handleRpc, type JsonRpcRequest, type HandleRpcOptions } from '@core/mcp/server';
import { config } from '@core/kernel/config';
import { createHash } from 'node:crypto';
import { issueSession, resolveSessionKey } from '@core/mcp/fast-surface';

/**
 * The shared Streamable-HTTP shell for every OS MCP endpoint (the overarching
 * `/api/mcp` and each per-tab `/api/mcp/<tab>`). It owns the transport + auth
 * machinery ONCE — bearer resolution, the JSON-RPC batch/single dispatch, the
 * 401/405/parse responses — and delegates all semantics to `handleRpc`. A per-tab
 * endpoint is just `serveMcp(req, { tools, serverInfo, instructions })`.
 */

function bearerFrom(req: Request): string | null {
  const h = req.headers.get('authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

export function mcpUnauthorized(): NextResponse {
  // The `resource_metadata` pointer (RFC 9728) is what starts Claude's managed-
  // authorization discovery chain. Absolute when OS_PUBLIC_URL is set (deploy);
  // relative locally (managed auth is a deploy-only surface).
  const base = config.osPublicUrl;
  const wwwAuthenticate =
    `Bearer realm="Sovereign Agentic OS MCP", ` +
    `resource_metadata="${base}/.well-known/oauth-protected-resource/api/mcp", ` +
    `scope="mcp:tools"`;
  return NextResponse.json(
    {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32001, message: 'Unauthorized: present a valid OS MCP bearer token' },
    },
    { status: 401, headers: { 'WWW-Authenticate': wwwAuthenticate } },
  );
}


/**
 * The Streamable-HTTP server→client stream (the transport's optional GET). Every OS
 * tool is request/response, so we have no server-initiated messages — but hosted
 * Claude opens this GET stream on connect and treats a 405 as a fatal "Method Not
 * Allowed", so we serve a real `text/event-stream` that stays open and idle (with a
 * keep-alive comment every 25s). All actual tool calls still flow over authenticated
 * POST; this stream carries no data, so it needs no bearer to sit idle.
 */
export function serveMcpStream(): Response {
  const enc = new TextEncoder();
  let ping: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode(': mcp stream open\n\n'));
      ping = setInterval(() => {
        try {
          controller.enqueue(enc.encode(': ping\n\n'));
        } catch {
          if (ping) clearInterval(ping);
        }
      }, 25000);
    },
    cancel() {
      if (ping) clearInterval(ping);
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // don't let the ingress buffer the stream
    },
  });
}

/**
 * The MCP session key for the fast external surface. The server assigns `Mcp-Session-Id` at
 * `initialize` (spec 2025-06-18, transports → session management) and the client echoes it; the
 * loaded toolsets hang off it, bound to the user. A client that does not echo the header falls back
 * to a key derived from its own bearer token. Only ids the server issued to THIS user are accepted;
 * a client-chosen or foreign id is rejected (404, per the spec's unknown-session rule).
 */
function sessionKeyFor(req: Request, bearer: string | null, userId: string): { key: string } | { rejected: true } {
  const tokenHash = createHash('sha256').update(bearer ?? '').digest('hex').slice(0, 32);
  return resolveSessionKey(req.headers.get('mcp-session-id') ?? '', tokenHash, userId);
}

const sse = (obj: unknown): string => `event: message\ndata: ${JSON.stringify(obj)}\n\n`;

/**
 * Resolve the bearer, then dispatch a single request or a JSON-RPC batch.
 *
 * `door.fast` selects the FAST external surface (`core/mcp/fast-surface.ts`): a core read toolset,
 * named toolsets on demand, compact lists. Only the overarching `/api/mcp` sets it; the per-tab
 * lenses keep their full per-tab tool sets.
 */
export async function serveMcp(req: Request, opts: HandleRpcOptions = {}, door: { fast?: boolean } = {}): Promise<NextResponse> {
  const bearer = bearerFrom(req);
  const user = await resolveMcpUser(bearer);
  if (!user) return mcpUnauthorized();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
      { status: 400 },
    );
  }

  let sessionKey = '';
  if (door.fast) {
    const k = sessionKeyFor(req, bearer, user.id);
    if ('rejected' in k) {
      return NextResponse.json(
        { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unknown MCP session: reconnect to start a new one' } },
        { status: 404 },
      );
    }
    sessionKey = k.key;
  }
  const notifications: { jsonrpc: '2.0'; method: string }[] = [];
  const dispatch = (r: JsonRpcRequest) =>
    handleRpc(user, r, door.fast ? { ...opts, fast: { sessionKey, notify: (n) => notifications.push(n) } } : opts);

  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((r) => dispatch(r as JsonRpcRequest)))).filter(
      (r): r is NonNullable<typeof r> => r !== null,
    );
    return out.length ? NextResponse.json(out) : new NextResponse(null, { status: 202 });
  }

  const isInit = (body as JsonRpcRequest)?.method === 'initialize';
  const res = await dispatch(body as JsonRpcRequest);
  if (res === null) return new NextResponse(null, { status: 202 }); // a notification
  const headers: Record<string, string> = door.fast && isInit ? { 'Mcp-Session-Id': issueSession(user.id) } : {};
  // A call that changed the tool list (load_toolset) answers as an SSE stream — the notification
  // first, then the response — which the Streamable HTTP transport allows for any POST. A client
  // that only accepts JSON gets the plain response and re-reads tools/list as the result says.
  if (notifications.length && (req.headers.get('accept') ?? '').includes('text/event-stream')) {
    const payload = notifications.map(sse).join('') + sse(res);
    return new NextResponse(payload, { headers: { ...headers, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform' } });
  }
  return NextResponse.json(res, { headers });
}
