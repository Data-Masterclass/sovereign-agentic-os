/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { verifyNotionConnection } from '@/lib/connections';

export const dynamic = 'force-dynamic';

/**
 * Prove a Notion MCP connection is LIVE: run an MCP initialize + tools/list
 * round-trip through the stored token (owner-only) and return the advertised tool
 * names. The token is used only server-side as the bearer and never returned.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const result = await verifyNotionConnection(id, user.id);
    return NextResponse.json(result);
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
