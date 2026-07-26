/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { listFiles, readFile, writeFile } from '@/lib/agents/store';

export const dynamic = 'force-dynamic';

/**
 * The system's mock-Forgejo file API (whitelisted to system.yaml + per-agent
 * AGENT.md/MEMORY.md, which project onto the one source).
 *   GET  ?path=…  → one file (content + sha)   ·   GET → the file list
 *   PUT          → commit (optimistic-concurrency on sha)
 */

export const GET = withRoute<{ id: string }>(async ({ user, params, req }) => {
  const { id } = params;
  const path = new URL(req.url).searchParams.get('path');
  if (path) return NextResponse.json(readFile(id, user, path));
  const { files } = listFiles(id, user);
  return NextResponse.json({ files });
}, { defaultStatus: 500 });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const PUT = withRoute<{ id: string }, any>(async ({ user, params, body }) => {
  const { id } = params;
  if (typeof body.path !== 'string') {
    return NextResponse.json({ error: 'A file path is required.' }, { status: 400 });
  }
  const saved = writeFile(id, user, {
    path: body.path,
    content: typeof body.content === 'string' ? body.content : '',
    sha: typeof body.sha === 'string' ? body.sha : '',
  });
  return NextResponse.json(saved);
}, { parse: true, defaultStatus: 500 });
