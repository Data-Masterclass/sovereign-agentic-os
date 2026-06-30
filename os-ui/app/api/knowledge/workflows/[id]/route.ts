/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { getWorkflow, updateWorkflow, deleteWorkflow } from '@/lib/knowledge/store';
import { findGaps } from '@/lib/knowledge/gaps';
import { resolveEntityIndex } from '@/lib/knowledge/mock-entities';

export const dynamic = 'force-dynamic';

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

type Params = { params: Promise<{ id: string }> };

/** GET → full workflow view (meta + parsed steps). */
export async function GET(_req: Request, { params }: Params) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const view = getWorkflow(id, user);
    const index = await resolveEntityIndex(view.domain);
    const gaps = findGaps(view.workflow, index);
    return NextResponse.json({
      ...view,
      gaps,
      canEdit:
        view.owner === user.id ||
        user.role === 'builder' ||
        user.role === 'admin',
      canPublish: user.role === 'builder' || user.role === 'admin',
    });
  } catch (e) {
    return fail(e);
  }
}

/** PATCH → update the raw markdown source (with sha for optimistic concurrency). */
export async function PATCH(req: Request, { params }: Params) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const md = typeof body.md === 'string' ? body.md : undefined;
    if (!md) return NextResponse.json({ error: 'md is required' }, { status: 400 });
    const rec = updateWorkflow(id, user, { md, sha: body.sha });
    return NextResponse.json({ id: rec.id, title: rec.title, updatedAt: rec.updatedAt });
  } catch (e) {
    return fail(e);
  }
}

/** DELETE → remove a draft workflow. */
export async function DELETE(_req: Request, { params }: Params) {
  try {
    const user = await requireUser();
    const { id } = await params;
    deleteWorkflow(id, user);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
