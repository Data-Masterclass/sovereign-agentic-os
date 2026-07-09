/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { adminCtx, fail } from '../_ctx';
import { config } from '@/lib/core/config';
import { ALL_MCP_TOOLS, MCP_TABS } from '@/lib/mcp/server';
import { listAppsForUser } from '@/lib/apps';
import { getConnectionByApp } from '@/lib/infra/app-registry';
import { listConnectionsForUser } from '@/lib/connections';
import { isExposed } from '@/lib/connections';
import {
  buildMcpRegistry,
  STACK_MCP_SERVERS,
  OFFICIAL_PLATFORM_APIS,
  type OfficialToolInput,
  type OwnedMcpInput,
  type RegistryTool,
} from '@/lib/platform-admin/mcp-registry';

export const dynamic = 'force-dynamic';

/**
 * MCPs & APIs registry (Platform Admin). Admin-gated via `adminCtx`; the owned
 * lists are visibility-scoped to the caller so the Personal section shows only the
 * caller's own MCPs. The pure `buildMcpRegistry` shapes the four sections; this
 * route only does the impure gathering (OS registry, gateway, app + connection
 * registries) — best-effort, so a missing gateway degrades gracefully, never 500s.
 */

/** Best-effort live tool list from the LiteLLM gateway (same read as /api/gateway). */
async function liveGatewayTools(): Promise<RegistryTool[]> {
  try {
    const res = await fetch(`${config.litellmUrl}/v1/mcp/tools`, {
      headers: { authorization: `Bearer ${config.litellmMasterKey}`, accept: 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (Array.isArray(data?.tools) ? data.tools : []).map((t: Record<string, unknown>) => ({
      name: String(t.name ?? ''),
      description: String(t.description ?? '').replace(/\s+/g, ' ').trim() || undefined,
    }));
  } catch {
    return [];
  }
}

export async function GET() {
  try {
    const { user, opa } = await adminCtx();

    // 1. Official — the OS's own tool registry, flattened to the visibility floor.
    const officialTools: OfficialToolInput[] = ALL_MCP_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      minRole: t.minRole,
      tab: t.tab,
    }));

    // 2. Stack — static mirror of the gateway registry, enriched with live tools.
    const gatewayTools = await liveGatewayTools();

    // 3 + 4. Owned — app auto-MCPs + connection MCPs the caller can see. Both are
    // already visibility-scoped by their list functions; the builder splits them
    // into Shared (Shared/Certified) vs Personal (own) by tier.
    const owned: OwnedMcpInput[] = [];
    const apps = await listAppsForUser(user);
    for (const a of apps) {
      const c = getConnectionByApp(a.id);
      if (!c) continue;
      owned.push({
        id: a.id,
        source: 'app',
        name: c.name,
        description: a.description || `Auto-MCP for ${a.name} (${a.template}).`,
        endpoint: `mcp://${c.principal}`,
        principal: c.principal,
        tools: c.tools.map((t) => ({ name: t.name, description: t.description })),
        visibility: a.visibility,
        owner: a.owner,
        domain: a.domain,
      });
    }
    const conns = await listConnectionsForUser(user);
    for (const c of conns) {
      owned.push({
        id: c.id,
        source: 'connection',
        name: c.name,
        description: `${c.type} connection (${c.connector}) — governed tools.`,
        endpoint: c.endpoint || `mcp://${c.principal}`,
        principal: c.principal,
        tools: c.tools.filter(isExposed).map((t) => ({ name: t.name, description: t.description })),
        visibility: c.visibility,
        owner: c.owner,
        domain: c.domain,
      });
    }

    const registry = buildMcpRegistry({
      role: user.role,
      userId: user.id,
      officialTools,
      tabs: MCP_TABS,
      officialApis: OFFICIAL_PLATFORM_APIS,
      stackServers: STACK_MCP_SERVERS,
      liveGatewayTools: gatewayTools,
      ownedMcps: owned,
    });

    return NextResponse.json({ registry, opa, gatewayReachable: gatewayTools.length > 0 });
  } catch (e) {
    return fail(e);
  }
}
