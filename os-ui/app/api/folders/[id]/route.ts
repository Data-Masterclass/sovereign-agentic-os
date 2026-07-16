/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import {
  ensureHydrated,
  renameFolder,
  deleteFolder,
  type Principal,
} from '@/lib/folders';

/**
 * One folder row.
 *   PATCH  /api/folders/:id  { path }  → rename/move (rewrites descendant rows)
 *   DELETE /api/folders/:id            → delete (empty → remove; non-empty →
 *                                        re-parent members, never orphan them)
 *
 * Runs AS the signed-in user; both mutations are edit-scoped in the store
 * (`canManageArtifact`), so a non-owner without domain authority gets a 403.
 */
export const dynamic = 'force-dynamic';

async function principal(): Promise<Principal> {
  const u = await requireUser();
  await ensureHydrated();
  return { id: u.id, role: u.role, domains: u.domains };
}

function errorResponse(e: unknown): NextResponse {
  const status = (e as { status?: number }).status ?? 400;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await principal();
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as { path?: string };
    if (!body.path || !String(body.path).trim()) {
      return NextResponse.json({ error: 'a new path is required' }, { status: 400 });
    }
    const folder = renameFolder(user, id, String(body.path));
    return NextResponse.json({ folder });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await principal();
    const { id } = await ctx.params;
    const result = deleteFolder(user, id);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return errorResponse(e);
  }
}
