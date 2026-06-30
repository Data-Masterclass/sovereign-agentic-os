/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { createBet, listBets } from '@/lib/bigbets/store';
import { deriveBetName } from '@/lib/bigbets/model';
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
        solution: bet.solution ?? '',
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

/**
 * POST → create a Big Bet (Builder/Admin own; Creator drafts).
 *
 * The create form's shape: an Owner, one free-form Problem Statement, an optional
 * Solution Idea, the value target, and a planned go-live. The bet's display name
 * is DERIVED from the problem statement (no separate name field). Older callers
 * that still send `{ name, problem: { who, need, … } }` keep working.
 */
export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const b = await req.json().catch(() => ({}));

    // Accept either the new shape (problem = string statement) or the legacy
    // object shape (problem = { who, need, obstacle, impact }).
    const legacy = b?.problem && typeof b.problem === 'object';
    const owner: string = String(b?.owner ?? (legacy ? b.problem.who : '') ?? '').trim();
    const statement: string = String((legacy ? b?.problem?.need : b?.problem) ?? '').trim();
    const solution: string = String(b?.solution ?? (legacy ? b?.problem?.impact : '') ?? '').trim();

    if (!statement) {
      return NextResponse.json({ error: 'A problem statement is required.' }, { status: 400 });
    }

    const name = String(b?.name ?? '').trim() || deriveBetName(statement);

    const bet = createBet(principal(user), {
      name,
      problem: {
        who: owner,
        need: statement,
        obstacle: legacy ? String(b?.problem?.obstacle ?? '') : '',
        impact: legacy ? String(b?.problem?.impact ?? '') : '',
      },
      solution: solution || undefined,
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
