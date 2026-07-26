/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { listAppFiles, readAppFile, saveAppFile } from '@/lib/software/apps';

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

export const GET = withRoute<{ id: string }>(async ({ user, params, req }) => {
  const { id } = params;
  const path = new URL(req.url).searchParams.get('path');
  if (path) return NextResponse.json(await readAppFile(id, user, path));
  return NextResponse.json(await listAppFiles(id, user));
}, { defaultStatus: 500 });

export const PUT = withRoute<{ id: string }, { path?: string; content?: string; sha?: string; message?: string }>(async ({ user, params, body }) => {
  const { id } = params;
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
}, { parse: true, defaultStatus: 500 });
