/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { createBet, listBets, ensureHydrated } from '@/lib/bigbets/store';
import { deriveBetName } from '@/lib/bigbets';
import { principal } from '@/lib/bigbets/server';
import { deriveBet, completion } from '@/lib/bigbets/status';
import { rollup } from '@/lib/bigbets/roadmap';
import { realizedValue } from '@/lib/bigbets/value';

export const dynamic = 'force-dynamic';

/** GET → the bets the caller may view, each with a headline rollup + realized value. */
export const GET = withRoute(async ({ user, req }) => {
    const p = principal(user);
    const includeArchived = new URL(req.url).searchParams.get('archived') === '1';
    const bets = listBets(p, { includeArchived }).map((bet) => {
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
        folder: bet.folder ?? '/',
        components: bet.components.length,
        completion: completion(statuses),
        signal: road.signal,
        goLiveRealistic: road.goLiveRealistic,
        targetValue: bet.targetValue,
        realized: realizedValue(bet, user.id).realized,
      };
    });
    return NextResponse.json({ bets });
}, { hydrate: ensureHydrated, defaultStatus: 500 });

/**
 * POST → create a Big Bet (Builder/Admin own; Creator drafts).
 *
 * The create form's shape: an Owner, one free-form Problem Statement, an optional
 * Solution Idea, the value target, and a planned go-live. The bet's display name
 * is DERIVED from the problem statement (no separate name field). Older callers
 * that still send `{ name, problem: { who, need, … } }` keep working.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const POST = withRoute<Record<string, string>, any>(async ({ user, body: b }) => {
    // Accept either the new shape (problem = string statement) or the legacy
    // object shape (problem = { who, need, obstacle, impact }).
    const legacy = b?.problem && typeof b.problem === 'object';
    const owner: string = String(b?.owner ?? (legacy ? b.problem.who : '') ?? '').trim();
    const statement: string = String((legacy ? b?.problem?.need : b?.problem) ?? '').trim();
    const solution: string = String(b?.solution ?? (legacy ? b?.problem?.impact : '') ?? '').trim();

    // Empty statement → derives "Untitled big bet" via deriveBetName; that's intentional.
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
      pillarId: b.pillarId || undefined,
      metricId: b.metricId || undefined,
      targetValue: Number(b.targetValue) || 0,
      goLive: b.goLive ?? new Date(Date.now() + 56 * 86400000).toISOString().slice(0, 10),
      domain: typeof b.domain === 'string' ? b.domain : undefined,
      crossDomain: Boolean(b.crossDomain),
      valueBasis: b.valueBasis,
      allocation: b.allocation,
      members: Array.isArray(b.members) ? b.members : undefined,
    });
    return NextResponse.json({ id: bet.id });
}, { parse: true, hydrate: ensureHydrated, defaultStatus: 500 });
