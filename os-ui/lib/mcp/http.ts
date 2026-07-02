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
  return NextResponse.json(
    {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32001, message: 'Unauthorized: present a valid OS MCP bearer token' },
    },
    { status: 401, headers: { 'WWW-Authenticate': 'Bearer realm="Sovereign Agentic OS MCP"' } },
  );
}

/** Streamable HTTP offers no server-initiated SSE stream — POST JSON-RPC only. */
export function mcpMethodNotAllowed(): NextResponse {
  return NextResponse.json(
    { error: 'Method Not Allowed — this MCP endpoint uses Streamable HTTP: POST JSON-RPC 2.0.' },
    { status: 405, headers: { Allow: 'POST' } },
  );
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
