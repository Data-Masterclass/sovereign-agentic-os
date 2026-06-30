/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { listPillars, createPillar } from '@/lib/strategy/pillars';
import { canCreatePillar, type PillarScope } from '@/lib/strategy/model';

export const dynamic = 'force-dynamic';

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

/** RLS-scoped pillar list: tenant pillars + the caller's domain pillars. */
export async function GET() {
  try {
    const user = await requireUser();
    const items = await listPillars(user);
    return NextResponse.json({
      user,
      items,
      // Surface what the caller may create so the UI can gate the buttons.
      canCreateTenant: canCreatePillar(user, 'tenant', 'tenant'),
      canCreateDomain: user.domains.some((d) => canCreatePillar(user, 'domain', d)),
    });
  } catch (e) {
    return fail(e);
  }
}

/** Define a pillar (tenant = Admin; domain = Builder/Admin in that domain). */
export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const scope = (body?.scope === 'tenant' ? 'tenant' : 'domain') as PillarScope;
    const item = await createPillar(user, {
      name: String(body?.name ?? ''),
      description: body?.description ? String(body.description) : '',
      scope,
      domain: body?.domain ? String(body.domain) : undefined,
      metrics: Array.isArray(body?.metrics) ? body.metrics : [],
    });
    return NextResponse.json({ item }, { status: 201 });
  } catch (e) {
    return fail(e);
  }
}
