/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { callPlatformMcp, PLATFORM_MCP_TOOLS } from '@/lib/software/platform-mcp';

export const dynamic = 'force-dynamic';

/**
 * The Platform MCP front door (Software golden path — front door #2). An MCP
 * client (Claude Code / any MCP host) drives the SAME governed create→build→
 * preview→deploy flow as the UI. The GOVERNANCE INVARIANT holds by construction:
 * every call runs under the caller's delegated identity and delegates to the
 * exact same governed library functions the UI uses — no privileged back door.
 */
export async function GET() {
  try {
    const user = await requireUser();
    return NextResponse.json({ user, tools: PLATFORM_MCP_TOOLS });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}

export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const body = (await req.json().catch(() => ({}))) as { tool?: string; args?: Record<string, unknown> };
    if (!body.tool) return NextResponse.json({ error: 'An MCP `tool` is required' }, { status: 400 });
    const result = await callPlatformMcp(user, body.tool, body.args ?? {});
    return NextResponse.json({ tool: body.tool, result });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
