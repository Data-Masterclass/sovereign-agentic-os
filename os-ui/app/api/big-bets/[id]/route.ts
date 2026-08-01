/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { buildBetView, principal } from '@/lib/bigbets/server';
import { updateBet, archiveBet, unarchiveBet, deleteBet, renameBet, ensureHydrated } from '@/lib/bigbets/store';
import { type ValueBasis, type AllocationMethod, type BigBet } from '@/lib/bigbets';

export const dynamic = 'force-dynamic';

const BASES: ValueBasis[] = ['uplift', 'absolute', 'owner-declared'];
const METHODS: AllocationMethod[] = ['manual', 'usage', 'equal'];

/**
 * GET → the full bet view (derived status + roadmap + value + composition + audit).
 * `?basis=` / `?allocation=` preview the value model without persisting the choice.
 */
export const GET = withRoute<{ id: string }>(async ({ user, params, req }) => {
    const { id } = params;
    const url = new URL(req.url);
    const basis = url.searchParams.get('basis');
    const allocation = url.searchParams.get('allocation');
    const view = await buildBetView(id, user, {
      basis: basis && BASES.includes(basis as ValueBasis) ? (basis as ValueBasis) : undefined,
      allocation: allocation && METHODS.includes(allocation as AllocationMethod) ? (allocation as AllocationMethod) : undefined,
      today: url.searchParams.get('today') ?? undefined,
    });
    return NextResponse.json(view);
}, { defaultStatus: 500 });

/**
 * POST → bet lifecycle: `rename` (display-name only — the id is frozen), `archive`
 * (reversible soft-hide) or `unarchive`. Edit-scoped in the store (owner, in-domain
 * domain_admin, or admin), so a viewer is rejected 403.
 */
export const POST = withRoute<{ id: string }, { action?: string; name?: string }>(async ({ user, params, body }) => {
    const { id } = params;
    switch (body.action) {
      case 'rename':
        // Display-name change only — the bet's id is its frozen identity, so no
        // component ref, pillar link or audit key ever moves. Edit-scoped.
        return NextResponse.json({ bet: renameBet(id, principal(user), body.name ?? '') });
      case 'archive':
        return NextResponse.json({ bet: archiveBet(id, principal(user)) });
      case 'unarchive':
        return NextResponse.json({ bet: unarchiveBet(id, principal(user)) });
      default:
        return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
    }
}, { parse: true, hydrate: ensureHydrated, defaultStatus: 500 });

/** DELETE → permanently remove a bet + its version history (edit-scoped). */
export const DELETE = withRoute<{ id: string }>(async ({ user, params }) => {
    const { id } = params;
    deleteBet(id, principal(user));
    return NextResponse.json({ ok: true });
}, { hydrate: ensureHydrated, defaultStatus: 500 });

/** PATCH → update bet fields (name, problem, target, go-live, basis, allocation, members, status). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const PATCH = withRoute<{ id: string }, any>(async ({ user, params, body }) => {
    const { id } = params;
    // `note` is provenance for the audit trail (e.g. the rationale behind a
    // reported value) — not a bet field. Everything else is whitelisted + typed
    // inside updateBet, so untrusted keys never reach the record.
    const { note, ...patch } = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const bet = updateBet(id, principal(user), patch as Partial<BigBet>, typeof note === 'string' && note.trim() ? { note: note.trim() } : {});
    return NextResponse.json({ id: bet.id, updatedAt: bet.updatedAt });
}, { parse: true, defaultStatus: 500 });
