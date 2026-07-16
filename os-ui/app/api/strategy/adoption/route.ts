/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { adoptionBoard } from '@/lib/strategy/adoption';
import { entitledToDomain } from '@/lib/strategy';

export const dynamic = 'force-dynamic';

/**
 * The live adoption scoreboard — promoted/certified counts + active people by
 * domain, derived from the registry. RLS: the caller sees the tenant roll-up
 * (the shared company scorecard, always the FULL-tenant aggregate) plus only the
 * domains they are entitled to. A `domain` filter is honoured ONLY when the caller
 * is entitled to it — otherwise it is ignored, so a non-entitled domain can never
 * be laundered through the always-visible tenant row.
 */
export async function GET(req: Request) {
  try {
    const user = await requireUser();
    const { searchParams } = new URL(req.url);
    const requested = searchParams.get('domain') ?? undefined;
    const domain = requested && entitledToDomain(user, requested) ? requested : undefined;
    const board = await adoptionBoard(domain, user.id);
    const domains = board.domains.filter((d) => entitledToDomain(user, d.domain));
    return NextResponse.json({ ...board, domains });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
