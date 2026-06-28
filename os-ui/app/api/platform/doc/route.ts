/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { readComponentDoc } from '@/lib/componentDocs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Per-component docs (raw markdown).
 *
 * NATIVE implementation (no proxy). Reads `docs/components/<id>.md` straight off
 * the OS UI image (the docs are baked in — see images/os-ui/Dockerfile). The id
 * is sanitised to the alnum/-/_ alphabet so it can never walk out of the docs
 * directory. Rendered into the Components surface's side panel.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const raw = (url.searchParams.get('id') ?? '').trim();
  const id = raw.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!id) {
    return NextResponse.json({ error: 'Missing component id' }, { status: 400 });
  }
  const md = readComponentDoc(id);
  return new NextResponse(md, {
    status: 200,
    headers: { 'content-type': 'text/markdown; charset=utf-8' },
  });
}
