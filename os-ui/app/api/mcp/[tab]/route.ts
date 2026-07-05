/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { serveMcp, mcpMethodNotAllowed } from '@/lib/mcp/http';
import { isMcpTab, toolsForTab, MCP_SERVER_INFO } from '@/lib/mcp/server';
import { resourcesForTab, templatesForTab } from '@/lib/mcp/resources';
import { promptsForTab } from '@/lib/mcp/prompts';
import { buildInstructions } from '@/lib/mcp/instructions';
import { tabTitle } from '@/lib/tabs/context';

export const dynamic = 'force-dynamic';

/**
 * A PER-TAB MCP endpoint: the same governed OS MCP core, filtered to just the
 * tools that live under one tab (`/api/mcp/software`, `/api/mcp/data`, …). It
 * reuses the exact auth + JSON-RPC + governance machinery of `/api/mcp` — the
 * only difference is the tool subset, a per-tab serverInfo, and that tab's
 * CONTEXT.md served as MCP `instructions`. NOT a bypass: every tools/call still
 * routes through the same governed function and is re-gated by the caller's role.
 */
export async function POST(req: Request, ctx: { params: Promise<{ tab: string }> }) {
  const { tab } = await ctx.params;
  if (!isMcpTab(tab)) {
    return NextResponse.json(
      { jsonrpc: '2.0', id: null, error: { code: -32601, message: `Unknown MCP tab: ${tab}` } },
      { status: 404 },
    );
  }
  return serveMcp(req, {
    tools: toolsForTab(tab),
    resources: resourcesForTab(tab),
    resourceTemplates: templatesForTab(tab),
    prompts: promptsForTab(tab),
    serverInfo: {
      name: `sovereign-agentic-os-${tab}`,
      title: `Sovereign Agentic OS — ${tabTitle(tab)}`,
      version: MCP_SERVER_INFO.version,
    },
    // The tab brief + the shared governance core (roles + whoami-first + discover).
    instructions: buildInstructions(tab),
  });
}

export async function GET() {
  return mcpMethodNotAllowed();
}
