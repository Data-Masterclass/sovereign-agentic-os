/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { resolveTool, roleAllowed } from '@/lib/infra/tool-proxy';

/**
 * Embed metadata for one registry tool — how the ToolWindow should present it:
 *
 *   • `embed:'iframe'`  — same-origin `/tools/<key>/` frame (the proxy).
 *   • `embed:'own-tab'` — the tool cannot render inside the frame (root-absolute
 *     SPA assets colliding with os-ui's own routes, or WebSockets/headless);
 *     the UI shows the Tier-2 "open in its own tab" card instead. `consoleUrl`
 *     is the tool's own external URL, `null` when the operator configured none
 *     (the card says so honestly — never a dead link).
 *
 * Guarded exactly like the proxy route itself: session (401) + per-tool role
 * gate (403), so this leaks nothing the proxy would not.
 */
export const dynamic = 'force-dynamic';

export const GET = withRoute<{ tool: string }>(
  async ({ user, params }) => {
    const { tool: key } = params;
    const tool = resolveTool(key);
    if (!tool) return NextResponse.json({ error: `Unknown tool '${key}'` }, { status: 404 });
    if (!roleAllowed(user.role, tool.minRole)) {
      return NextResponse.json(
        { error: `Your role (${user.role}) cannot open ${tool.title}` },
        { status: 403 },
      );
    }

    const framable = tool.embeddable && tool.protocol === 'http' && !tool.ownTab;
    return NextResponse.json({
      key: tool.key,
      title: tool.title,
      embed: framable ? 'iframe' : 'own-tab',
      reason: framable ? null : (tool.ownTab?.reason ?? tool.note ?? null),
      consoleUrl: tool.ownTab?.consoleUrl?.trim() ? tool.ownTab.consoleUrl.trim() : null,
    });
  },
  { defaultStatus: 401 },
);
