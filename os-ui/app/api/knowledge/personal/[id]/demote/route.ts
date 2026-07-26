/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { ensureHydrated } from '@/lib/knowledge/personal-store';
import { demoteThroughSeam } from '@/lib/governance/ladder';

export const dynamic = 'force-dynamic';

/**
 * Revoke sharing on a personal ("My knowledge") entry one step DOWN the SAME
 * governed ladder every artifact rides:
 *   Marketplace ──(Admin)──▶ Shared ──(owner | in-domain Builder+)──▶ Personal
 * The rung is derived from the entry's current tier — never a silent jump. Never
 * deletes the entry; only lowers its visibility.
 */
export const POST = withRoute<{ id: string }>(async ({ user, params }) => {
    const { id } = params;
    const r = await demoteThroughSeam('personal_knowledge', id, user);
    return NextResponse.json({ ok: true, visibility: r.result.visibility, rung: r.rung });
}, { hydrate: ensureHydrated, defaultStatus: 500 });
