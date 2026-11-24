/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import { resolveTool, gateToolRequest, roleAllowed } from '@core/infra/tool-proxy';
import { consoleExposed } from '@tabs/admin/lib/tool-console-routes';

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
    // An own-tab tool is never framed through the proxy: its card points at the tool's OWN
    // ingress, so only the registry role applies. Everything else is the proxy's frame and gets
    // the same switch + console-role gate as the proxy (Platform → Tool consoles): an OFF
    // console does not exist (404), a non-admin is refused (403).
    if (tool.ownTab) {
      if (!roleAllowed(user.role, tool.minRole)) {
        return NextResponse.json({ error: `Your role (${user.role}) cannot open ${tool.title}` }, { status: 403 });
      }
    } else {
      const gate = gateToolRequest({ tool, path: [], role: user.role, exposed: await consoleExposed(tool.key) });
      if (gate.status === 404) return NextResponse.json({ error: `${tool.title} is not switched on (Platform → Tool consoles)` }, { status: 404 });
      if (gate.status === 403) return NextResponse.json({ error: gate.reason }, { status: 403 });
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
