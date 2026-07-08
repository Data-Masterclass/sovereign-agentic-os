/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { getSystem, archiveSystem, unarchiveSystem, deleteSystem, ensureHydrated } from '@/lib/agents/store';
import { purgeSystemResources } from '@/lib/agents/physical-delete';
import { realForgejo } from '@/lib/agents/build/live-clients';
import { reconcileScheduleCron } from '@/lib/agents/schedule-cron';
import { compile } from '@/lib/agents/langgraph-compile';
import { config } from '@/lib/config';

export const dynamic = 'force-dynamic';

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

/**
 * GET → one system: its metadata, the parsed system.yaml, and (best-effort) the
 * compiled IR for the canvas. A compile error is returned alongside the system so
 * the canvas can still render the agents and surface the error inline.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const view = getSystem(id, user);
    let ir = null;
    let compileError: string | null = null;
    try {
      ir = compile(view.system);
    } catch (e) {
      compileError = (e as Error).message;
    }
    const canEdit = view.owner === user.id || (user.role === 'admin' && user.domains.includes(view.domain));
    return NextResponse.json({
      id: view.id,
      name: view.name,
      domain: view.domain,
      owner: view.owner,
      visibility: view.visibility,
      origin: view.origin,
      running: view.running,
      schedule: view.schedule,
      disabledAgents: view.disabledAgents,
      lastActivity: view.lastActivity,
      lastBuild: view.lastBuild ?? null,
      system: view.system,
      ir,
      compileError,
      canEdit,
      role: user.role,
      // Whether the Hermes autonomous runtime is provisioned in this deployment.
      // The runtime option is always SHOWN (per plan); when false, selecting it is
      // documented as gated-off (no gateway provisioned in base/kind).
      hermesEnabled: config.hermesEnabled,
      archived: view.archived ?? false,
    });
  } catch (e) {
    return fail(e);
  }
}

/**
 * POST → system lifecycle: `archive` (reversible soft-hide + stop) or
 * `unarchive`. Edit-scoped in the store (owner or in-domain Admin), so a mere
 * viewer is rejected 403 — restoring/archiving obeys the same authz as editing.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await ensureHydrated();
    const user = await requireUser();
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as { action?: string };
    switch (body.action) {
      case 'archive': {
        // Archive stops the system + suspends its schedule CronJob (reconcile-to-none)
        // but KEEPS the repo + the saved `schedule` record, so unarchive re-provisions.
        const system = archiveSystem(id, user);
        const cron = await reconcileScheduleCron(id, { kind: 'manual' });
        return NextResponse.json({ system, cron });
      }
      case 'unarchive': {
        // Restore re-provisions the CronJob from the retained schedule (no-op if manual).
        const system = unarchiveSystem(id, user);
        const cron = await reconcileScheduleCron(id, system.schedule);
        return NextResponse.json({ system, cron });
      }
      default:
        return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
    }
  } catch (e) {
    return fail(e);
  }
}

/**
 * DELETE → permanently remove a system + its version history (edit-scoped), then
 * PHYSICALLY purge its backing resources: its Forgejo repo (`os-<id>`) and any
 * schedule CronJob. The record delete runs first (403 → nothing is purged); an
 * unreachable Forgejo / k8s API surfaces in `physical[].ok:false` — the delete
 * stands, the leftover is never silent.
 */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await ensureHydrated();
    const user = await requireUser();
    const { id } = await ctx.params;
    const rec = deleteSystem(id, user); // throws 403 → nothing is purged
    const physical = await purgeSystemResources(rec, {
      deleteRepo: (repo) => realForgejo().deleteRepo(repo),
      // Reconcile the schedule to "none" — deletes the CronJob (idempotent 404 = ok).
      teardownCron: async (systemId) => {
        const r = await reconcileScheduleCron(systemId, { kind: 'manual' });
        return { ok: r.ok, detail: r.detail };
      },
    });
    return NextResponse.json({ ok: true, physical });
  } catch (e) {
    return fail(e);
  }
}
