/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { listSystems, createSystem, ensureHydrated } from '@/lib/agents/store';
import { isTemplateKey } from '@/lib/agents/templates';

export const dynamic = 'force-dynamic';

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

/** GET → the caller's systems grouped Mine / My domain / Marketplace. */
export async function GET() {
  try {
    await ensureHydrated();
    const user = await requireUser();
    return NextResponse.json(listSystems(user));
  } catch (e) {
    return fail(e);
  }
}

/** POST → create a new system (lands under Mine). */
export async function POST(req: Request) {
  try {
    await ensureHydrated();
    const user = await requireUser();
    const body = await req.json().catch(() => ({}));
    const name = typeof body.name === 'string' ? body.name : '';
    if (!name.trim()) return NextResponse.json({ error: 'A system name is required.' }, { status: 400 });
    // Security: visibility is NOT accepted from the client — a new system is
    // always Personal. Sharing/publishing is the governed `promoteSystem` ladder.
    const rec = createSystem(user, {
      name,
      domain: typeof body.domain === 'string' ? body.domain : undefined,
      // A server-authored template only (validated key) — never client yaml.
      template: isTemplateKey(body.template) ? body.template : undefined,
    });
    return NextResponse.json({ id: rec.id });
  } catch (e) {
    return fail(e);
  }
}
