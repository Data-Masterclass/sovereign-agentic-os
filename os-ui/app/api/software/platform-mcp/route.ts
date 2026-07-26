/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { callPlatformMcp, PLATFORM_MCP_TOOLS } from '@/lib/software/platform-mcp';

export const dynamic = 'force-dynamic';

/**
 * The Platform MCP front door (Software golden path — front door #2). An MCP
 * client (Claude Code / any MCP host) drives the SAME governed create→build→
 * preview→deploy flow as the UI. The GOVERNANCE INVARIANT holds by construction:
 * every call runs under the caller's delegated identity and delegates to the
 * exact same governed library functions the UI uses — no privileged back door.
 */
export const GET = withRoute(async ({ user }) => {
  return NextResponse.json({ user, tools: PLATFORM_MCP_TOOLS });
}, { defaultStatus: 500 });

export const POST = withRoute<Record<string, string>, { tool?: string; args?: Record<string, unknown> }>(async ({ user, body }) => {
  if (!body.tool) return NextResponse.json({ error: 'An MCP `tool` is required' }, { status: 400 });
  const result = await callPlatformMcp(user, body.tool, body.args ?? {});
  return NextResponse.json({ tool: body.tool, result });
}, { parse: true, defaultStatus: 500 });
