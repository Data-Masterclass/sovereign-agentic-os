/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute, apiError } from '@core/kernel/route-server';
import { getConnectionView, deleteConnection, setConnectionArchived, renameConnection, rotateConnectionCredential } from '@tabs/connections/lib/index';

export const dynamic = 'force-dynamic';

export const GET = withRoute<{ id: string }>(async ({ user, params }) => {
    const { id } = params;
    // Full record when you may use it; another domain's Company connection comes back redacted.
    const connection = await getConnectionView(id, user);
    return NextResponse.json({ connection });
}, { defaultStatus: 500 });

/**
 * POST → connection lifecycle: `archive` (reversible soft-hide), `unarchive`, or
 * `rename` (DISPLAY name only). Edit-scoped (owner or domain admin) in the lib.
 * The vault secret + OAuth token are KEPT, so an archived connection reconnects with no
 * re-auth. A rename NEVER moves the FROZEN physical identity (principal / Trino catalog /
 * K8s secret name) — the store writes only the display `name`.
 */
export const POST = withRoute<{ id: string }, { action?: string; name?: string; credential?: string }>(async ({ user, params, body }) => {
    const { id } = params;
    switch (body.action) {
      case 'rename':
        return NextResponse.json({ connection: await renameConnection(id, user, body.name ?? '') });
      case 'archive':
        return NextResponse.json({ connection: await setConnectionArchived(id, user, true) });
      case 'unarchive':
        return NextResponse.json({ connection: await setConnectionArchived(id, user, false) });
      case 'rotate-credential':
        // Re-supply the vaulted credential over the same ref (M13). The secret is read from
        // the body server-side and written straight to Secrets Manager — never returned.
        return NextResponse.json({ connection: await rotateConnectionCredential(id, user, body.credential ?? '') });
      default:
        return apiError(400, 'Unknown action', 'connections.unknownAction');
    }
}, { parse: true, defaultStatus: 500 });

export const DELETE = withRoute<{ id: string }>(async ({ user, params }) => {
    const { id } = params;
    const physical = await deleteConnection(id, user);
    return NextResponse.json({ ok: true, physical });
}, { defaultStatus: 500 });
