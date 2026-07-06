/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { buildBetView, principal } from '@/lib/bigbets/server';
import { updateBet } from '@/lib/bigbets/store';
import { type ValueBasis, type AllocationMethod, type BigBet } from '@/lib/bigbets/model';

export const dynamic = 'force-dynamic';

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

const BASES: ValueBasis[] = ['uplift', 'absolute', 'owner-declared'];
const METHODS: AllocationMethod[] = ['manual', 'usage', 'equal'];

/**
 * GET → the full bet view (derived status + roadmap + value + composition + audit).
 * `?basis=` / `?allocation=` preview the value model without persisting the choice.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const url = new URL(req.url);
    const basis = url.searchParams.get('basis');
    const allocation = url.searchParams.get('allocation');
    const view = await buildBetView(id, user, {
      basis: basis && BASES.includes(basis as ValueBasis) ? (basis as ValueBasis) : undefined,
      allocation: allocation && METHODS.includes(allocation as AllocationMethod) ? (allocation as AllocationMethod) : undefined,
      today: url.searchParams.get('today') ?? undefined,
    });
    return NextResponse.json(view);
  } catch (e) {
    return fail(e);
  }
}

/** PATCH → update bet fields (name, problem, target, go-live, basis, allocation, members, status). */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const body = await req.json().catch(() => ({}));
    // `note` is provenance for the audit trail (e.g. the rationale behind a
    // reported value) — not a bet field. Everything else is whitelisted + typed
    // inside updateBet, so untrusted keys never reach the record.
    const { note, ...patch } = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const bet = updateBet(id, principal(user), patch as Partial<BigBet>, typeof note === 'string' && note.trim() ? { note: note.trim() } : {});
    return NextResponse.json({ id: bet.id, updatedAt: bet.updatedAt });
  } catch (e) {
    return fail(e);
  }
}
