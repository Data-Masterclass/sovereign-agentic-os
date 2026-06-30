/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { createBet, listBets } from '@/lib/bigbets/store';
import { principal } from '@/lib/bigbets/server';
import { deriveBet, completion } from '@/lib/bigbets/status';
import { rollup } from '@/lib/bigbets/roadmap';
import { realizedValue } from '@/lib/bigbets/value';

export const dynamic = 'force-dynamic';

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

/** GET → the bets the caller may view, each with a headline rollup + realized value. */
export async function GET() {
  try {
    const user = await requireUser();
    const p = principal(user);
    const bets = listBets(p).map((bet) => {
      const statuses = deriveBet(bet.components);
      const road = rollup(bet.components, statuses, bet.goLive);
      return {
        id: bet.id,
        name: bet.name,
        domain: bet.domain,
        owner: bet.owner,
        crossDomain: bet.crossDomain,
        pillarId: bet.pillarId,
        problem: bet.problem,
        goLive: bet.goLive,
        status: bet.status,
        components: bet.components.length,
        completion: completion(statuses),
        signal: road.signal,
        goLiveRealistic: road.goLiveRealistic,
        targetValue: bet.targetValue,
        realized: realizedValue(bet, user.id).realized,
      };
    });
    return NextResponse.json({ bets });
  } catch (e) {
    return fail(e);
  }
}

/** POST → create a Big Bet (Builder/Admin own; Creator drafts). */
export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const b = await req.json().catch(() => ({}));
    if (!b?.name?.trim()) return NextResponse.json({ error: 'A bet name is required.' }, { status: 400 });
    if (!b?.problem?.who || !b?.problem?.need) {
      return NextResponse.json({ error: 'A problem statement (who / need / obstacle / impact) is required.' }, { status: 400 });
    }
    const bet = createBet(principal(user), {
      name: b.name,
      problem: { who: b.problem.who, need: b.problem.need, obstacle: b.problem.obstacle ?? '', impact: b.problem.impact ?? '' },
      pillarId: b.pillarId ?? 'pillar_retention',
      metricId: b.metricId ?? 'metric_nrr',
      targetValue: Number(b.targetValue) || 0,
      goLive: b.goLive ?? new Date(Date.now() + 56 * 86400000).toISOString().slice(0, 10),
      domain: typeof b.domain === 'string' ? b.domain : undefined,
      crossDomain: Boolean(b.crossDomain),
      valueBasis: b.valueBasis,
      allocation: b.allocation,
      members: Array.isArray(b.members) ? b.members : undefined,
    });
    return NextResponse.json({ id: bet.id });
  } catch (e) {
    return fail(e);
  }
}
