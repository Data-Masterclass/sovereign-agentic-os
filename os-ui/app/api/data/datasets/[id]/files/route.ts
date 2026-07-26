/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import type { CurrentUser } from '@/lib/core/auth';
import { requirePrincipal } from '@/lib/data/server';
import { listFiles, readFile, writeFile } from '@/lib/data/store';

export const dynamic = 'force-dynamic';

/**
 * The "Show the code" surface: the dataset's Forgejo-versioned files. Without a
 * `path` it lists them; with one it returns that file. PUT writes back the single
 * source (`dataset.yaml`) — the same file the guided panels and the data agent edit.
 */
export const GET = withRoute<{ id: string }>(async ({ user, params, req }) => {
  const { id } = params;
  const path = new URL(req.url).searchParams.get('path');
  if (!path) return NextResponse.json(listFiles(id, user));
  return NextResponse.json(readFile(id, user, path));
}, { gate: requirePrincipal as () => Promise<CurrentUser> });

export const PUT = withRoute<{ id: string }, { path?: string; content?: string; sha?: string }>(async ({ user, params, body }) => {
  const { id } = params;
  if (!body.path || typeof body.content !== 'string') {
    return NextResponse.json({ error: 'path and content are required' }, { status: 400 });
  }
  return NextResponse.json(writeFile(id, user, { path: body.path, content: body.content, sha: body.sha ?? '' }));
}, { parse: true, gate: requirePrincipal as () => Promise<CurrentUser> });
