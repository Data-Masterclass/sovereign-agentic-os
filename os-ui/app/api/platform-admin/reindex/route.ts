/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { adminCtx } from '../_ctx';
import { audit } from '@tabs/admin/lib/audit';
import { isReindexFilter, isReindexTarget, jobFor, type ReindexFilter, type ReindexService, type ReindexTarget } from '@core/kernel/reindex';
import { filesReindexService } from '@tabs/files/lib/reindex';
import { knowledgeReindexService } from '@tabs/knowledge/lib/reindex';

export const dynamic = 'force-dynamic';

/**
 * ADMIN re-index of the Files / Knowledge OpenSearch index — the HTTP twin of the MCP tool
 * `reindex_corpus` and of the Platform → Re-index panel, over the SAME tab-owned services.
 *
 *   GET  ?target=files|knowledge   the target's current job AND whether a batch is in flight (a
 *                                  poll that writes nothing). `inFlight` is what the panel's
 *                                  Continue gates on: a RUNNING job with no batch in flight is
 *                                  exactly the state that needs continuing, and the first version
 *                                  greyed the button out precisely then (review H2).
 *   POST { target, mode, filter, batch }
 *                                  mode 'plan' = dry run (writes nothing, works while the engines
 *                                  are down); mode 'run' = ONE bounded batch — on a target whose
 *                                  job is already running it RESUMES from the cursor without
 *                                  re-planning (review M4); mode 'abandon' = give up on the
 *                                  running job, clearing the in-flight flag (review H3).
 *
 * Gated by `adminCtx()` (401 anon · 403 non-admin · tenant-pinned) and audited per call; the
 * services re-check admin in-lib, so neither door is the only gate. Deliberately THIN: a
 * `route.ts` cannot be imported by a test, so every decision — the classification, the refusal,
 * the one-job-per-target rule — lives in `tabs/{files,knowledge}/lib/reindex.ts` and
 * `core/kernel/reindex.ts`, which are tested.
 *
 * The typed offline-mock refusal (an unreachable Docling or embeddings gateway) carries
 * `status: 503` and `code: 'ENGINE_UNAVAILABLE'`, and BOTH are forwarded: review H3 of PR #56
 * found this surface flattening every error to 400, so a refusal reached the browser as "bad
 * request" instead of "a component is down and nothing was written".
 */

const SERVICES: Record<ReindexTarget, ReindexService> = {
  files: filesReindexService,
  knowledge: knowledgeReindexService,
};

function errorResponse(e: unknown): NextResponse {
  const status = (e as { status?: number })?.status ?? 500;
  const code = (e as { code?: string })?.code;
  return NextResponse.json({ error: (e as Error).message, ...(code ? { code } : {}) }, { status });
}

export async function GET(req: Request) {
  try {
    await adminCtx();
    const target = new URL(req.url).searchParams.get('target') ?? '';
    if (!isReindexTarget(target)) {
      return NextResponse.json({ error: 'target must be "files" or "knowledge"' }, { status: 400 });
    }
    const job = jobFor(target);
    return NextResponse.json({
      target,
      job,
      running: job?.status === 'running',
      inFlight: SERVICES[target].inFlight(),
    });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const { user, tenant } = await adminCtx();
    const body = (await req.json().catch(() => ({}))) as { target?: unknown; mode?: unknown; filter?: unknown; batch?: unknown };
    const target = typeof body.target === 'string' ? body.target : '';
    if (!isReindexTarget(target)) {
      return NextResponse.json({ error: 'target must be "files" or "knowledge"' }, { status: 400 });
    }
    const mode = body.mode === 'run' ? 'run' : body.mode === 'abandon' ? 'abandon' : 'plan';
    const rawFilter = typeof body.filter === 'string' && body.filter ? body.filter : 'marked';
    if (!isReindexFilter(rawFilter)) {
      return NextResponse.json({ error: 'filter must be "marked" or "all"' }, { status: 400 });
    }
    const filter: ReindexFilter = rawFilter;
    const principal = { id: user.id, domains: user.domains, role: user.role };
    const service = SERVICES[target];

    // ABANDON (review H3): no plan, no probe, no write to the index — it only releases the job
    // slot and the in-flight flag, so a target wedged by a killed process can be re-run.
    if (mode === 'abandon') {
      const out = await service.abandonReindex(principal);
      audit({
        tenant: tenant.id, actor: user.id, role: user.role, action: 'reindex.abandon', target: `index:${target}`,
        detail: out.abandoned
          ? `Abandoned job ${out.job?.id} at ${out.job?.cursor}/${out.job?.total} — the units already replaced stand; the rest were not touched`
          : 'Nothing was running; cleared any stale in-flight flag',
        guarded: true,
      });
      return NextResponse.json({ mode, abandoned: out.abandoned, reason: out.reason ?? null, job: out.job });
    }

    // RESUME without re-planning (review M4): a `run` against a target whose job is already
    // running continues THAT job from its cursor. Re-planning here would cost a full index read
    // per batch and could compute a different unit list than the one the cursor indexes into.
    const batch = typeof body.batch === 'number' ? body.batch : undefined;
    const running = jobFor(target);
    if (mode === 'run' && running?.status === 'running') {
      const out = await service.runReindex(principal, null, { batch });
      audit({
        tenant: tenant.id, actor: user.id, role: user.role, action: 'reindex.run', target: `index:${target}`,
        detail:
          `Continued a ${out.job.filter} re-index: job ${out.job.id}, ${out.job.cursor}/${out.job.total} done, ` +
          `${out.job.replaced} replaced, ${out.job.failed} failed, ${out.job.skipped} skipped`,
        guarded: true,
      });
      return NextResponse.json({ mode, started: false, reason: out.reason ?? 'resumed', job: out.job });
    }

    const plan = await service.planReindex(principal, { filter });
    if (mode === 'plan') {
      audit({
        tenant: tenant.id, actor: user.id, role: user.role, action: 'reindex.plan', target: `index:${target}`,
        detail: `Dry run (${filter}): ${plan.units.length} unit(s) selected of ${plan.rowsTotal} row(s); marked=${plan.counts.marked}, no-vector=${plan.counts['missing-vector']}, no-representation=${plan.counts['missing-representation']}, dim-mismatch=${plan.counts['dimension-mismatch']}`,
      });
      return NextResponse.json({ mode, plan });
    }

    if (!plan.ready) {
      audit({
        tenant: tenant.id, actor: user.id, role: user.role, action: 'reindex.run', target: `index:${target}`,
        detail: `Refused: ${plan.blockedReason}`, result: 'error',
      });
      return NextResponse.json({ error: plan.blockedReason, code: 'ENGINE_UNAVAILABLE', plan }, { status: 503 });
    }

    const out = await service.runReindex(principal, plan, { batch });
    audit({
      tenant: tenant.id, actor: user.id, role: user.role, action: 'reindex.run', target: `index:${target}`,
      detail:
        `${out.started ? 'Started' : out.reason === 'already-running' ? 'Reported the run in flight for' : 'Resumed'} ` +
        // `out.job.filter` and NOT the request's: a resume reports the filter the RUNNING job was
        // started with, which is the one that decided what is being re-indexed (review low 3).
        `a ${out.job.filter} re-index: job ${out.job.id}, ${out.job.cursor}/${out.job.total} done, ` +
        `${out.job.replaced} replaced, ${out.job.failed} failed, ${out.job.skipped} skipped`,
      guarded: true,
    });
    return NextResponse.json({ mode, started: out.started, reason: out.reason ?? null, job: out.job, counts: plan.counts, caveat: plan.unmarkedCaveat });
  } catch (e) {
    return errorResponse(e);
  }
}
