/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The per-system model keys, for admins: which systems have a usable key, when the
 *             legacy-key sweep last ran and what it removed; run the sweep; rotate one key; the
 *             continuous reconcile's drift report, and "re-apply from the OS" for one system.
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
 *   POST is a write at the gateway: OPA must allow `admin` for the caller before either action
 *   runs (`authorize`, fatal here; `adminCtx` alone treats it as defense-in-depth). A body that
 *   is not JSON is a 400, never read as an empty action.
 */
import { NextResponse } from 'next/server';
import { adminCtx, fail } from '../../_ctx';
import { authorize } from '@core/infra/governed';
import { lastKeySweep } from '@core/infra/agent-system-key-sweep';
import { lastKeyReconcile } from '@core/infra/agent-key-drift';
import { config } from '@core/kernel/config';
import { lastKeyMigration, migrateThenSweepLive } from '@tabs/agents/lib/build/system-key-migration';
import { ensureHydrated, getSystemForEdit, listAllSystemsInternal } from '@tabs/agents/lib/store';
import { governYamlForOwner } from '@tabs/agents/lib/build/owner-grants';
import { listSystemKeyRows, reapplySystemKey, rotateSystemKey } from '@tabs/agents/lib/build/system-key-admin';
import { parseAutoCorrect, reconcileKeysLive } from '@tabs/agents/lib/build/key-reconcile';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await adminCtx();
    await ensureHydrated();
  } catch (e) {
    return fail(e);
  }
  const systems = await listSystemKeyRows(listAllSystemsInternal().map((s) => ({ id: s.id, name: s.name })));
  const auto = parseAutoCorrect(config.agentKeyReconcile.autoCorrectSystems);
  return NextResponse.json({
    systems,
    sweep: lastKeySweep(),
    migration: lastKeyMigration(),
    // The continuous reconcile: its last pass (null before the first) and how it is set — read-only here;
    // auto-correct is a deployment value (`osUI.agentSystemKey.reconcile.autoCorrectSystems`), per system.
    reconcile: lastKeyReconcile(),
    reconcileMode: { intervalSeconds: config.agentKeyReconcile.intervalSeconds, autoCorrect: auto === 'all' ? 'all' : [...auto].sort() },
  });
}

export async function POST(req: Request) {
  let ctx;
  try {
    ctx = await adminCtx();
    await ensureHydrated();
  } catch (e) {
    return fail(e);
  }
  const authz = await authorize(`user:${ctx.user.id}`, 'admin');
  if (!authz.allowed) return NextResponse.json({ error: 'not allowed by policy', policy: authz.policy }, { status: 403 });
  let body: { action?: unknown; systemId?: unknown };
  try {
    body = (await req.json()) as { action?: unknown; systemId?: unknown };
  } catch {
    return NextResponse.json({ error: 'the body must be JSON: {"action":"sweep"}, {"action":"rotate","systemId":"…"} or {"action":"reapply","systemId":"…"}' }, { status: 400 });
  }
  if (body.action === 'sweep') {
    const { migration, sweep } = await migrateThenSweepLive();
    return NextResponse.json({ migration, sweep, by: ctx.user.id });
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
  if (body.action === 'reapply') {
    const systemId = typeof body.systemId === 'string' ? body.systemId.trim() : '';
    if (!systemId) return NextResponse.json({ error: 'reapply needs a systemId' }, { status: 400 });
    try {
      const view = getSystemForEdit(systemId, ctx.user);
      const drift = lastKeyReconcile()?.entries.find((e) => e.systemId === systemId);
      const outcome = await reapplySystemKey(systemId, await governYamlForOwner(view.yaml, view.owner), { actor: ctx.user.id, domain: view.domain, ...(drift ? { drift } : {}) });
      // Refresh the report so the alert clears (or stays, with the reason) without waiting for the timer.
      const reconcile = outcome.ok ? await reconcileKeysLive().catch(() => lastKeyReconcile()) : lastKeyReconcile();
      return NextResponse.json({ ...outcome, reconcile, by: ctx.user.id }, { status: outcome.ok ? 200 : 502 });
    } catch (e) {
      return fail(e);
    }
  }
  return NextResponse.json({ error: 'unknown action — use "sweep", "rotate" or "reapply"' }, { status: 400 });
}
