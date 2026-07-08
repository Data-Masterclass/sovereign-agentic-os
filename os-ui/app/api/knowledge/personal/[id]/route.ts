/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import {
  getPersonalKnowledge,
  updatePersonalKnowledge,
  deletePersonalKnowledge,
  archivePersonalKnowledge,
  unarchivePersonalKnowledge,
  ensureHydrated,
} from '@/lib/knowledge/personal-store';

export const dynamic = 'force-dynamic';

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

type Params = { params: Promise<{ id: string }> };

/** GET → one personal knowledge entry (view-scoped). */
export async function GET(_req: Request, { params }: Params) {
  try {
    const user = await requireUser();
    await ensureHydrated();
    const { id } = await params;
    return NextResponse.json(getPersonalKnowledge(id, user));
  } catch (e) {
    return fail(e);
  }
}

/** PATCH → edit title and/or markdown body (edit-scoped, versioned). */
export async function PATCH(req: Request, { params }: Params) {
  try {
    const user = await requireUser();
    await ensureHydrated();
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const rec = updatePersonalKnowledge(id, user, {
      title: typeof body.title === 'string' ? body.title : undefined,
      md: typeof body.md === 'string' ? body.md : undefined,
    });
    return NextResponse.json({ id: rec.id, title: rec.title, updatedAt: rec.updatedAt });
  } catch (e) {
    return fail(e);
  }
}

/** POST → lifecycle: archive (reversible soft-hide) / unarchive. */
export async function POST(req: Request, { params }: Params) {
  try {
    await ensureHydrated();
    const user = await requireUser();
    const { id } = await params;
    const body = (await req.json().catch(() => ({}))) as { action?: string };
    switch (body.action) {
      case 'archive':
        return NextResponse.json({ entry: archivePersonalKnowledge(id, user) });
      case 'unarchive':
        return NextResponse.json({ entry: unarchivePersonalKnowledge(id, user) });
      default:
        return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
    }
  } catch (e) {
    return fail(e);
  }
}

/** DELETE → permanently remove a personal entry + its version history (edit-scoped). */
export async function DELETE(_req: Request, { params }: Params) {
  try {
    await ensureHydrated();
    const user = await requireUser();
    const { id } = await params;
    deletePersonalKnowledge(id, user);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
