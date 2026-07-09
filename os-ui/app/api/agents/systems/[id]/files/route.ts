/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { listFiles, readFile, writeFile } from '@/lib/agents/store';

export const dynamic = 'force-dynamic';

/**
 * The system's mock-Forgejo file API (whitelisted to system.yaml + per-agent
 * AGENT.md/MEMORY.md, which project onto the one source).
 *   GET  ?path=…  → one file (content + sha)   ·   GET → the file list
 *   PUT          → commit (optimistic-concurrency on sha)
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
    if (path) return NextResponse.json(readFile(id, user, path));
    const { files } = listFiles(id, user);
    return NextResponse.json({ files });
  } catch (e) {
    return fail(e);
  }
}

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const body = await req.json().catch(() => ({}));
    if (typeof body.path !== 'string') {
      return NextResponse.json({ error: 'A file path is required.' }, { status: 400 });
    }
    const saved = writeFile(id, user, {
      path: body.path,
      content: typeof body.content === 'string' ? body.content : '',
      sha: typeof body.sha === 'string' ? body.sha : '',
    });
    return NextResponse.json(saved);
  } catch (e) {
    return fail(e);
  }
}
