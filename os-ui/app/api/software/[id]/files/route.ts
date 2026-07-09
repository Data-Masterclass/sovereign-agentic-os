/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { listAppFiles, readAppFile, saveAppFile } from '@/lib/apps';

export const dynamic = 'force-dynamic';

/**
 * In-browser code editor backend for the Software golden path (Layer 3). Reads
 * and commits an app's source straight from its per-app Forgejo repo:
 *
 *   GET  /api/software/{id}/files            → flat recursive file list (tree)
 *   GET  /api/software/{id}/files?path=a/b   → one file's content + blob SHA
 *   PUT  /api/software/{id}/files            → save = commit to Forgejo (main)
 *
 * Builder/Admin-gated AND domain-scoped server-side (in lib/apps.ts), so the
 * role gate holds even if the UI is bypassed. Forgejo-unreachable degrades to a
 * clear 502, never a crash.
 */

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const path = new URL(req.url).searchParams.get('path');
    if (path) return NextResponse.json(await readAppFile(id, user, path));
    return NextResponse.json(await listAppFiles(id, user));
  } catch (e) {
    return fail(e);
  }
}

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const body = await req.json().catch(() => ({}));
    if (!body || typeof body.path !== 'string') {
      return NextResponse.json({ error: 'A file path is required.' }, { status: 400 });
    }
    const saved = await saveAppFile(id, user, {
      path: body.path,
      content: typeof body.content === 'string' ? body.content : '',
      sha: typeof body.sha === 'string' ? body.sha : '',
      message: typeof body.message === 'string' ? body.message : undefined,
    });
    return NextResponse.json(saved);
  } catch (e) {
    return fail(e);
  }
}
