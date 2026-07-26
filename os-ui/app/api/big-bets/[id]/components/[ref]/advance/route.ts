/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { advanceComponent } from '@/lib/bigbets/store';
import { actor } from '@/lib/bigbets/server';
import { type Lifecycle } from '@/lib/bigbets';

export const dynamic = 'force-dynamic';

const LIFECYCLES: Lifecycle[] = [
  'planned', 'building', 'draft', 'staging', 'untested',
  'certified', 'promoted', 'published', 'deployed', 'live', 'production', 'tested-governed',
];

/**
 * POST → advance a component through its tab's governed lifecycle (build →
 * certify/promote/publish/deploy/go-live). Promotion is human-only: the store +
 * source reject a planner actor for any ready transition, so this route only ever
 * runs as the authenticated human.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const POST = withRoute<{ id: string; ref: string }, any>(async ({ user, params, body: b }) => {
    const { id, ref } = params;
    if (!LIFECYCLES.includes(b.to)) return NextResponse.json({ error: `to must be one of ${LIFECYCLES.join(', ')}` }, { status: 400 });
    advanceComponent(id, actor(user), ref, b.to);
    return NextResponse.json({ ok: true });
}, { parse: true, defaultStatus: 500 });
