/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { listSystems, createSystem } from '@/lib/agents/store';

export const dynamic = 'force-dynamic';

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

/** GET → the caller's systems grouped Mine / My domain / Marketplace. */
export async function GET() {
  try {
    const user = await requireUser();
    return NextResponse.json(listSystems(user));
  } catch (e) {
    return fail(e);
  }
}

/** POST → create a new system (lands under Mine). */
export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const body = await req.json().catch(() => ({}));
    const name = typeof body.name === 'string' ? body.name : '';
    if (!name.trim()) return NextResponse.json({ error: 'A system name is required.' }, { status: 400 });
    const rec = createSystem(user, {
      name,
      domain: typeof body.domain === 'string' ? body.domain : undefined,
      visibility: body.visibility === 'Shared' || body.visibility === 'Marketplace' ? body.visibility : undefined,
    });
    return NextResponse.json({ id: rec.id });
  } catch (e) {
    return fail(e);
  }
}
