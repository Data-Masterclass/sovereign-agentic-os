/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { archiveArtifact, deleteArtifact, getArtifact, updateArtifact } from '@/lib/core/artifacts';

export const dynamic = 'force-dynamic';

export const GET = withRoute<{ id: string }>(async ({ params }) => {
  const { id } = params;
  const item = await getArtifact(id);
  if (!item) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ item });
}, { defaultStatus: 500 });

/** Edit metadata (name/description/tags/spec) — owner or domain admin only. */
export const PATCH = withRoute<{ id: string }>(async ({ user, params, req }) => {
  const { id } = params;
  const body = await req.json();
  const item = await updateArtifact(id, user, {
    name: body?.name !== undefined ? String(body.name) : undefined,
    description: body?.description !== undefined ? String(body.description) : undefined,
    tags: Array.isArray(body?.tags) ? body.tags.map(String) : undefined,
    spec: typeof body?.spec === 'object' && body?.spec ? body.spec : undefined,
  });
  return NextResponse.json({ item });
}, { defaultStatus: 500 });

/** Lifecycle: archive / unarchive (reversible soft-hide) — edit-scoped. */
export const POST = withRoute<{ id: string }, { action?: string }>(async ({ user, params, body }) => {
  const { id } = params;
  if (body?.action === 'archive' || body?.action === 'unarchive') {
    const item = await archiveArtifact(id, user, body.action === 'archive');
    return NextResponse.json({ item });
  }
  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}, { parse: true, defaultStatus: 500 });

export const DELETE = withRoute<{ id: string }>(async ({ user, params }) => {
  const { id } = params;
  await deleteArtifact(id, user);
  return NextResponse.json({ ok: true });
}, { defaultStatus: 500 });
