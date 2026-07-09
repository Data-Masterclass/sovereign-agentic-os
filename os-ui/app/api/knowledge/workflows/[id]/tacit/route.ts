/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { getTacit, updateTacit } from '@/lib/knowledge/store';

export const dynamic = 'force-dynamic';

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

type Params = { params: Promise<{ id: string }> };

/** GET → the workflow's sibling tacit.md. */
export async function GET(_req: Request, { params }: Params) {
  try {
    const user = await requireUser();
    const { id } = await params;
    return NextResponse.json(getTacit(id, user));
  } catch (e) {
    return fail(e);
  }
}

/** PUT → replace the workflow's tacit.md (knowledge-agent-compressed markdown). */
export async function PUT(req: Request, { params }: Params) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const tacit = typeof body.tacit === 'string' ? body.tacit : '';
    const rec = updateTacit(id, user, tacit);
    return NextResponse.json({ id: rec.id, updatedAt: rec.updatedAt });
  } catch (e) {
    return fail(e);
  }
}
