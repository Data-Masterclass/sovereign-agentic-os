/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { config } from '@/lib/config';

export const dynamic = 'force-dynamic';

/**
 * Per-component docs (raw markdown).
 *
 * Server-side proxy to the Admin Console (GET /api/doc/<id>), which returns the
 * component's documentation as raw markdown. Rendered into the Components
 * surface's side panel. The id is sanitised to the same alnum/-/_ alphabet the
 * Admin Console itself accepts, so this can't be used to walk its routes.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const raw = (url.searchParams.get('id') ?? '').trim();
  const id = raw.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!id) {
    return NextResponse.json({ error: 'Missing component id' }, { status: 400 });
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`${config.adminConsoleUrl}/api/doc/${encodeURIComponent(id)}`, {
      cache: 'no-store',
      signal: ctrl.signal,
      headers: { accept: 'text/markdown' },
    });
    const text = await res.text();
    if (!res.ok) {
      return NextResponse.json(
        { error: `Admin Console ${res.status}: ${text.slice(0, 160)}` },
        { status: 502 },
      );
    }
    return new NextResponse(text, {
      status: 200,
      headers: { 'content-type': 'text/markdown; charset=utf-8' },
    });
  } catch (e) {
    return NextResponse.json(
      { error: `Could not reach the Admin Console: ${(e as Error).message}` },
      { status: 502 },
    );
  } finally {
    clearTimeout(timer);
  }
}
