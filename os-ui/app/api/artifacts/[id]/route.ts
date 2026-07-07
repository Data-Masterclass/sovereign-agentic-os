/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { archiveArtifact, deleteArtifact, getArtifact, updateArtifact } from '@/lib/artifacts';

export const dynamic = 'force-dynamic';

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireUser();
    const { id } = await ctx.params;
    const item = await getArtifact(id);
    if (!item) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ item });
  } catch (e) {
    return fail(e);
  }
}

/** Edit metadata (name/description/tags/spec) — owner or domain admin only. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const body = await req.json();
    const item = await updateArtifact(id, user, {
      name: body?.name !== undefined ? String(body.name) : undefined,
      description: body?.description !== undefined ? String(body.description) : undefined,
      tags: Array.isArray(body?.tags) ? body.tags.map(String) : undefined,
      spec: typeof body?.spec === 'object' && body?.spec ? body.spec : undefined,
    });
    return NextResponse.json({ item });
  } catch (e) {
    return fail(e);
  }
}

/** Lifecycle: archive / unarchive (reversible soft-hide) — edit-scoped. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const body = await req.json().catch(() => ({}));
    if (body?.action === 'archive' || body?.action === 'unarchive') {
      const item = await archiveArtifact(id, user, body.action === 'archive');
      return NextResponse.json({ item });
    }
    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (e) {
    return fail(e);
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    await deleteArtifact(id, user);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
