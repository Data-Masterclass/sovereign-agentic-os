/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import type { CurrentUser } from '@core/kernel/auth';
import { requirePrincipal } from '@tabs/files/lib/server';
import { runConnectorSync } from '@tabs/files/lib/connectors-server';
import { getSource, requireSourcesLoaded } from '@tabs/files/lib/connectors';
import { principalById } from '@core/kernel/auth';
import { resolveConnectionAccessToken } from '@tabs/connections/lib/index';

export const dynamic = 'force-dynamic';

/**
 * Sync a connected source NOW. The first run is the overnight batch (Dagster
 * best-effort), later runs are incremental. The OAuth Read token is resolved from
 * the source's LINKED Connection (its stored, refreshable credential in Secrets
 * Manager) — NOT from a header/env var — so the sync pulls the user's REAL drive.
 * With no linked connection or no live token the live client refuses (production) or,
 * in the local teaching flow only, uses the fake drive. Files land re-governed under our
 * tiers and are auto-indexed.
 */
export const POST = withRoute<{ id: string }>(async ({ user, params }) => {
  const { id } = params;
  // Resolve the real OAuth token from the linked Connection (owner-gated inside;
  // silent refresh; null → mock). The token never leaves this server path.
  await requireSourcesLoaded();
  const source = getSource(id);
  // The owner's live status, domain and drive grant are re-checked inside, on every run.
  const result = await runConnectorSync(id, user.id, {
    liveOwner: principalById,
    token: async () => (source?.connectionId ? resolveConnectionAccessToken(source.connectionId, user.id) : null),
  });
  return NextResponse.json(result);
}, { gate: requirePrincipal as () => Promise<CurrentUser> });
