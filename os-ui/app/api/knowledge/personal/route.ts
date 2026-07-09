/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { listPersonalKnowledge, createPersonalKnowledge, ensureHydrated } from '@/lib/knowledge/personal-store';

export const dynamic = 'force-dynamic';

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

/** GET → caller's personal knowledge grouped mine / domain / marketplace. Pass ?archived=1 to include archived. */
export async function GET(req: Request) {
  try {
    const user = await requireUser();
    await ensureHydrated();
    const url = new URL(req.url);
    const includeArchived = url.searchParams.get('archived') === '1';
    return NextResponse.json(listPersonalKnowledge(user, { includeArchived }));
  } catch (e) {
    return fail(e);
  }
}

/** POST → create a personal knowledge entry (a titled markdown note about the user). */
export async function POST(req: Request) {
  try {
    const user = await requireUser();
    await ensureHydrated();
    const body = await req.json().catch(() => ({}));
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) return NextResponse.json({ error: 'A title is required.' }, { status: 400 });
    const rec = createPersonalKnowledge(user, {
      title,
      md: typeof body.md === 'string' ? body.md : undefined,
      domain: typeof body.domain === 'string' ? body.domain : undefined,
    });
    return NextResponse.json({ id: rec.id, title: rec.title });
  } catch (e) {
    return fail(e);
  }
}
