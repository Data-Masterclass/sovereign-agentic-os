/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { listWorkflows, createWorkflow, ensureHydrated } from '@/lib/knowledge/store';

export const dynamic = 'force-dynamic';

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

/** GET → caller's workflows grouped mine / domain / marketplace. Pass ?archived=1 to include archived. */
export async function GET(req: Request) {
  try {
    const user = await requireUser();
    await ensureHydrated();
    const url = new URL(req.url);
    const includeArchived = url.searchParams.get('archived') === '1';
    return NextResponse.json(listWorkflows(user, { includeArchived }));
  } catch (e) {
    return fail(e);
  }
}

/** POST → create a new draft workflow. */
export async function POST(req: Request) {
  try {
    const user = await requireUser();
    await ensureHydrated();
    const body = await req.json().catch(() => ({}));
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) return NextResponse.json({ error: 'A workflow title is required.' }, { status: 400 });
    const rec = createWorkflow(user, {
      title,
      domain: typeof body.domain === 'string' ? body.domain : undefined,
    });
    return NextResponse.json({ id: rec.id, title: rec.title });
  } catch (e) {
    return fail(e);
  }
}
