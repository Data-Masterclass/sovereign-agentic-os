/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/files/server';
import { runConnectorSync } from '@/lib/files/connectors-server';

export const dynamic = 'force-dynamic';

/**
 * Sync a connected source NOW. The first run is the overnight batch (Dagster
 * best-effort), later runs are incremental. The OAuth Read token is resolved from
 * the governed Connection; when absent (kind) the live client falls back to the
 * mock fake-drive so the flow runs offline. Files land re-governed under our tiers
 * and are auto-indexed.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requirePrincipal();
    const { id } = await ctx.params;
    // Token resolution from the Connection is wired on deploy; null → mock client.
    const token = (req.headers.get('x-connection-token') || process.env.FILES_CONNECTOR_TOKEN) ?? null;
    const result = await runConnectorSync(id, user.id, token);
    return NextResponse.json(result);
  } catch (e) {
    return errorResponse(e);
  }
}
