/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/files/server';
import { runConnectorSync } from '@/lib/files/connectors-server';
import { getSource } from '@/lib/files/connectors';
import { resolveConnectionAccessToken } from '@/lib/connections';

export const dynamic = 'force-dynamic';

/**
 * Sync a connected source NOW. The first run is the overnight batch (Dagster
 * best-effort), later runs are incremental. The OAuth Read token is resolved from
 * the source's LINKED Connection (its stored, refreshable credential in Secrets
 * Manager) — NOT from a header/env var — so the sync pulls the user's REAL drive.
 * When there is no linked connection or no live token (offline / kind), the live
 * client falls back to the mock fake-drive so the flow still runs. Files land
 * re-governed under our tiers and are auto-indexed.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requirePrincipal();
    const { id } = await ctx.params;
    // Resolve the real OAuth token from the linked Connection (owner-gated inside;
    // silent refresh; null → mock). The token never leaves this server path.
    const source = getSource(id);
    const token = source?.connectionId
      ? await resolveConnectionAccessToken(source.connectionId, user.id)
      : null;
    const result = await runConnectorSync(id, user.id, token);
    return NextResponse.json(result);
  } catch (e) {
    return errorResponse(e);
  }
}
