/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { proxy, resolveTool, roleAllowed } from '@/lib/tool-proxy';

/**
 * Same-origin reverse proxy for embedded tools:
 * `/tools/<tool>/<...path>` → the tool's in-cluster upstream, served by this
 * Node server. Gated by `requireUser()` (401 like every /api/* route) and the
 * per-tool role gate (403). The OS session is the ONLY credential the browser
 * presents; lib/tool-proxy.ts injects whatever the upstream needs.
 */
export const dynamic = 'force-dynamic';

async function handle(
  req: Request,
  ctx: { params: Promise<{ tool: string; path?: string[] }> },
): Promise<Response> {
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 401;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }

  const { tool: key, path } = await ctx.params;
  const tool = resolveTool(key);
  if (!tool) return NextResponse.json({ error: `Unknown tool '${key}'` }, { status: 404 });

  if (!roleAllowed(user.role, tool.minRole)) {
    return NextResponse.json(
      { error: `Your role (${user.role}) cannot open ${tool.title}` },
      { status: 403 },
    );
  }
  if (!tool.embeddable || tool.protocol === 'ws') {
    return NextResponse.json(
      { error: `${tool.title} is not HTTP-embeddable`, note: tool.note },
      { status: 501 },
    );
  }

  return proxy(req, tool, path ?? [], user);
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const HEAD = handle;
export const OPTIONS = handle;
