/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { proxy, resolveTool, gateToolRequest, unsafePathSegment, type SessionSso } from '@core/infra/tool-proxy';
import { getLangfuseSessionCookies, hasLangfuseSession } from '@core/infra/tool-sso-langfuse';
import { getLiteLlmSessionCookies, hasLiteLlmSession } from '@core/infra/tool-sso-litellm';
import { consoleExposed, userOrResponse } from '@tabs/admin/lib/tool-console-routes';

/**
 * Same-origin reverse proxy for tool consoles:
 * `/tools/<tool>/<...path>` → the tool's in-cluster upstream, served by this
 * Node server. Gated by the OS session (a signed-out page load is sent to sign
 * in, anything else gets 401), then by the Platform → Tool consoles switch and
 * the console role (`gateToolRequest`): a console that is OFF answers 404 for
 * everyone, admins included; ON, only admins get in. A tool's public paths
 * (LiteLLM's Model Hub) keep their own audience either way. The OS session is
 * the ONLY credential the browser presents; lib/tool-proxy.ts injects whatever
 * the upstream needs. See docs/ops/tool-consoles.md.
 */
export const dynamic = 'force-dynamic';

async function handle(
  req: Request,
  ctx: { params: Promise<{ tool: string; path?: string[] }> },
): Promise<Response> {
  const who = await userOrResponse(req);
  if ('response' in who) return who.response;
  const user = who.user;

  const { tool: key, path } = await ctx.params;
  const tool = resolveTool(key);
  if (!tool) return NextResponse.json({ error: `Unknown tool '${key}'` }, { status: 404 });
  if (unsafePathSegment(path ?? []) !== null) return NextResponse.json({ error: 'Invalid path' }, { status: 400 });

  // Per-PATH gate, decided per request, so a sub-resource fetch is gated exactly
  // like the document that asked for it.
  const gate = gateToolRequest({ tool, path: path ?? [], role: user.role, exposed: await consoleExposed(tool.key) });
  if (gate.status === 404) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (gate.status === 403) return NextResponse.json({ error: gate.reason }, { status: 403 });

  // Session-SSO tools get a server-minted session injected when the browser has
  // none yet. The provider fails soft (returns [] → tool's own login).
  let sessionSso: SessionSso | undefined;
  if (tool.key === 'langfuse') {
    sessionSso = { active: hasLangfuseSession, provide: () => getLangfuseSessionCookies() };
  } else if (tool.key === 'litellm' && gate.needsAdminSso) {
    // Only the admin console gets a session; the public hub stays credential-free.
    sessionSso = { active: hasLiteLlmSession, provide: () => getLiteLlmSessionCookies() };
  }

  // fetchImpl `undefined` = the proxy's own default (the global fetch).
  return proxy(req, tool, path ?? [], user, undefined, sessionSso, { adminRequest: gate.needsAdminSso });
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const HEAD = handle;
export const OPTIONS = handle;
