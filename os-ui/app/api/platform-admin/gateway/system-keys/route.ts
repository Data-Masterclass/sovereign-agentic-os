/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The per-system model keys, for admins: which systems have a usable key, when the
 *             legacy-key sweep last ran and what it removed; run the sweep; rotate one key.
 *
 * USER STORY: As a platform admin I see which agent systems still need a Build before they can
 *             run, I can remove guessable keys from the gateway on demand, and I can replace one
 *             system's key without anyone ever being shown a key.
 *
 * ARCHITECTURE:
 *   Gated by `adminCtx()`, like every Platform-Admin route. Nothing here returns key material:
 *   the status rows carry alias, timestamps and caps; the sweep result carries aliases and
 *   counts. POST takes an ACTION NAME and a system id only — never an endpoint or a payload —
 *   so the route cannot be used as a proxy for the gateway's admin API. Rotation goes through
 *   `getSystemForEdit` with the admin's own identity, so the agents tab's edit rule still applies.
 */
import { NextResponse } from 'next/server';
import { adminCtx, fail } from '../../_ctx';
import { lastKeySweep, sweepLegacySystemKeys } from '@core/infra/agent-system-key-sweep';
import { ensureHydrated, getSystemForEdit, listAllSystemsInternal } from '@tabs/agents/lib/store';
import { governYamlForOwner } from '@tabs/agents/lib/build/owner-grants';
import { listSystemKeyRows, rotateSystemKey } from '@tabs/agents/lib/build/system-key-admin';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await adminCtx();
    await ensureHydrated();
  } catch (e) {
    return fail(e);
  }
  const systems = await listSystemKeyRows(listAllSystemsInternal().map((s) => ({ id: s.id, name: s.name })));
  return NextResponse.json({ systems, sweep: lastKeySweep() });
}

export async function POST(req: Request) {
  let ctx;
  try {
    ctx = await adminCtx();
    await ensureHydrated();
  } catch (e) {
    return fail(e);
  }
  const body = (await req.json().catch(() => ({}))) as { action?: unknown; systemId?: unknown };
  if (body.action === 'sweep') {
    return NextResponse.json({ sweep: await sweepLegacySystemKeys(), by: ctx.user.id });
  }
  if (body.action === 'rotate') {
    const systemId = typeof body.systemId === 'string' ? body.systemId.trim() : '';
    if (!systemId) return NextResponse.json({ error: 'rotate needs a systemId' }, { status: 400 });
    try {
      const view = getSystemForEdit(systemId, ctx.user);
      const outcome = await rotateSystemKey(systemId, await governYamlForOwner(view.yaml, view.owner));
      return NextResponse.json({ ...outcome, by: ctx.user.id }, { status: outcome.ok ? 200 : 502 });
    } catch (e) {
      return fail(e);
    }
  }
  return NextResponse.json({ error: 'unknown action — use "sweep" or "rotate"' }, { status: 400 });
}
