/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { NextResponse } from 'next/server';
import { resolveMcpUser } from '@/lib/mcp/token';
import { handleRpc, type JsonRpcRequest, type HandleRpcOptions } from '@/lib/mcp/server';

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
  const base = (process.env.OS_PUBLIC_URL ?? '').replace(/\/+$/, '');
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

/** Streamable HTTP offers no server-initiated SSE stream — POST JSON-RPC only. */
export function mcpMethodNotAllowed(): NextResponse {
  return NextResponse.json(
    { error: 'Method Not Allowed — this MCP endpoint uses Streamable HTTP: POST JSON-RPC 2.0.' },
    { status: 405, headers: { Allow: 'POST' } },
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

/** Resolve the bearer, then dispatch a single request or a JSON-RPC batch. */
export async function serveMcp(req: Request, opts: HandleRpcOptions = {}): Promise<NextResponse> {
  const user = await resolveMcpUser(bearerFrom(req));
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

  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((r) => handleRpc(user, r as JsonRpcRequest, opts)))).filter(
      (r): r is NonNullable<typeof r> => r !== null,
    );
    return out.length ? NextResponse.json(out) : new NextResponse(null, { status: 202 });
  }

  const res = await handleRpc(user, body as JsonRpcRequest, opts);
  if (res === null) return new NextResponse(null, { status: 202 }); // a notification
  return NextResponse.json(res);
}
