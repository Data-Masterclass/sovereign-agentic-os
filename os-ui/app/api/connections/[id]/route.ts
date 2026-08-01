/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { getConnectionForUser, deleteConnection, setConnectionArchived, renameConnection } from '@/lib/connections';

export const dynamic = 'force-dynamic';

export const GET = withRoute<{ id: string }>(async ({ user, params }) => {
    const { id } = params;
    const connection = await getConnectionForUser(id, user);
    return NextResponse.json({ connection });
}, { defaultStatus: 500 });

/**
 * POST → connection lifecycle: `archive` (reversible soft-hide), `unarchive`, or
 * `rename` (DISPLAY name only). Edit-scoped (owner or domain admin) in the lib.
 * The vault secret + OAuth token are KEPT, so an archived connection reconnects with no
 * re-auth. A rename NEVER moves the FROZEN physical identity (principal / Trino catalog /
 * K8s secret name) — the store writes only the display `name`.
 */
export const POST = withRoute<{ id: string }, { action?: string; name?: string }>(async ({ user, params, body }) => {
    const { id } = params;
    switch (body.action) {
      case 'rename':
        return NextResponse.json({ connection: await renameConnection(id, user, body.name ?? '') });
      case 'archive':
        return NextResponse.json({ connection: await setConnectionArchived(id, user, true) });
      case 'unarchive':
        return NextResponse.json({ connection: await setConnectionArchived(id, user, false) });
      default:
        return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
    }
}, { parse: true, defaultStatus: 500 });

export const DELETE = withRoute<{ id: string }>(async ({ user, params }) => {
    const { id } = params;
    const physical = await deleteConnection(id, user);
    return NextResponse.json({ ok: true, physical });
}, { defaultStatus: 500 });
