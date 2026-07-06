/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { serveMcp, serveMcpStream } from '@/lib/mcp/http';

export const dynamic = 'force-dynamic';

/**
 * THE overarching Sovereign Agentic OS remote MCP endpoint.
 *
 * Transport: MCP over Streamable HTTP (the standard Claude & ChatGPT remote-MCP
 * support), JSON-RPC 2.0. A client POSTs a single request (or a batch) and gets a
 * single `application/json` response — we hold no long-lived stream because every
 * OS tool is request/response, so a GET SSE stream is not offered (405).
 *
 * Auth: an OS-issued per-user bearer token (Authorization: Bearer <token>),
 * resolved to the LIVE delegated identity. Unauthenticated → HTTP 401 + a
 * JSON-RPC error. Designed so OAuth2 can slot in behind `resolveMcpUser` later.
 *
 * Governance: `handleRpc` routes every `tools/call` to the same governed library
 * function the UI uses, under the caller's identity — OPA + audit + role gates
 * apply unchanged. No secret ever reaches the client.
 */

// The overarching endpoint: the FULL governed registry, all tabs. Per-tab
// filtered lenses live at /api/mcp/<tab> and share this same transport shell.
export async function POST(req: Request) {
  return serveMcp(req);
}

// Streamable HTTP: serve the (idle) server→client SSE stream on GET. Hosted Claude
// opens this on connect and treats a 405 as fatal, so we return a real event-stream.
export async function GET() {
  return serveMcpStream();
}
