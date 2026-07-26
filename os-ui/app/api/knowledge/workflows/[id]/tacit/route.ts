/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { getTacit, updateTacit } from '@/lib/knowledge/store';

export const dynamic = 'force-dynamic';

/** GET → the workflow's sibling tacit.md. */
export const GET = withRoute<{ id: string }>(async ({ user, params }) => {
    const { id } = params;
    return NextResponse.json(getTacit(id, user));
}, { defaultStatus: 500 });

/** PUT → replace the workflow's tacit.md (knowledge-agent-compressed markdown). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const PUT = withRoute<{ id: string }, any>(async ({ user, params, body }) => {
    const { id } = params;
    const tacit = typeof body.tacit === 'string' ? body.tacit : '';
    const rec = updateTacit(id, user, tacit);
    return NextResponse.json({ id: rec.id, updatedAt: rec.updatedAt });
}, { parse: true, defaultStatus: 500 });
