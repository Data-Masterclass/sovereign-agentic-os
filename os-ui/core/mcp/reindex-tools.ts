/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    `reindex_corpus` — the MCP twin of the Platform → Re-index panel
 * USER STORY: As an admin working through an agent I want to dry-run the Files and Knowledge
 *             index debt, read the counts, and then run the re-index in bounded batches I can
 *             poll — and I want the tool to refuse, typed, rather than re-write the stand-ins it
 *             exists to remove.
 * ARCHITECTURE:
 *   - A FACTORY OVER INJECTED SERVICES, and that is the whole point. One tool must serve two
 *     corpora; a tab may not import another tab, so the tool cannot live in either Files or
 *     Knowledge. It lives here and imports NO TAB at all: `reindexTools(services)` receives the
 *     two tab-owned `ReindexService`s, and `core/mcp/register-experimental.ts` — which already
 *     loads every tab bundle by dynamic import() for code-splitting — is the one place that
 *     knows both names. The kernel still does not know its tabs.
 *   - ONE JOB PER TARGET lives in `@core/kernel/reindex`, so this door and the HTTP route cannot
 *     disagree: a second `mode:'run'` while a run is in flight reports that job's progress
 *     (`started:false`, `reason:'already-running'`) instead of starting a twin — the same
 *     skip-not-queue honesty `sync_dataset_now` reports, and never a phantom success.
 *   - THE REFUSAL IS NOT CAUGHT HERE. An unreachable parser or gateway throws the typed
 *     `ENGINE_UNAVAILABLE`, and `core/mcp/server.ts` `structuredError` — the ONE error-mapping
 *     door — hands the agent `{error:{code:'ENGINE_UNAVAILABLE', …}}`. Catching it here to
 *     return a friendly object would turn a 503 into a 200, which is the exact shape of the bug
 *     this whole branch exists to close.
 *   - HONESTY IN THE PAYLOAD. Every answer carries the plan's `caveat`: rows fabricated before
 *     the production guard that carry no marker cannot be found by `marked`. An agent that reads
 *     only `counts.marked` would otherwise report a clean corpus.
 */
import 'server-only';
import type { McpTool } from '@core/mcp/server';
import { fail, P, str, num, bool } from '@core/mcp/write-common';
import {
  REINDEX_FILTERS,
  REINDEX_TARGETS,
  isReindexFilter,
  isReindexTarget,
  jobFor,
  type ReindexFilter,
  type ReindexJob,
  type ReindexPlan,
  type ReindexService,
  type ReindexTarget,
} from '@core/kernel/reindex';

export type ReindexServices = Record<ReindexTarget, ReindexService>;

/** The plan, as an agent sees it: the counts and the caveat, with the unit list capped to a sample. */
export function planPayload(plan: ReindexPlan): Record<string, unknown> {
  return {
    target: plan.target,
    filter: plan.filter,
    ready: plan.ready,
    blockedReason: plan.blockedReason,
    counts: plan.counts,
    rowsTotal: plan.rowsTotal,
    unitsSelected: plan.units.length,
    truncated: plan.truncated,
    mappingDim: plan.mappingDim,
    configuredDim: plan.configuredDim,
    engines: plan.engines,
    sample: plan.units.slice(0, 20).map((u) => ({ id: u.id, label: u.label, reasons: u.reasons, rows: u.rows })),
    caveat: plan.unmarkedCaveat,
  };
}

/** The job, as an agent sees it — the same vocabulary the panel polls. */
export function jobPayload(job: ReindexJob): Record<string, unknown> {
  return {
    id: job.id,
    target: job.target,
    filter: job.filter,
    status: job.status,
    total: job.total,
    done: job.cursor,
    remaining: Math.max(0, job.total - job.cursor),
    replaced: job.replaced,
    failed: job.failed,
    skipped: job.skipped,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    by: job.by,
    failures: job.failures,
    error: job.error,
  };
}

const DESCRIPTION =
  'ADMIN ONLY. Re-parse and re-embed the Files or Knowledge OpenSearch index through the REAL ' +
  'services (Docling for files; the embeddings gateway for both) — the remedy the CHANGELOG ' +
  'records as the UPGRADE ACTION for rows written before the production offline-mock guard, when ' +
  'an unreachable parser invented a document’s text and an unreachable gateway wrote HASH ' +
  'vectors. The SAME governed services as POST /api/platform-admin/reindex and the Platform → ' +
  'Re-index panel. `mode:"plan"` is a DRY RUN: it writes nothing, works while the engines are ' +
  'down, and returns counts per reason (marked · missing-representation · missing-vector · ' +
  'dimension-mismatch · all) plus `ready`/`blockedReason` and a sample of the units a run would ' +
  'touch. `mode:"run"` does ONE BOUNDED BATCH and returns the job — call it again to continue ' +
  'from its cursor until `status` is "done"; a run already in flight for that target reports ' +
  '`started:false, reason:"already-running"` with that job’s real progress rather than starting a ' +
  'twin (skip-not-queue, like sync_dataset_now). HONESTY, and read this before reporting a clean ' +
  'corpus: `filter:"marked"` can only find rows that still carry EVIDENCE (a persisted stand-in ' +
  'label, no vector at all, or an index whose knn dimension no longer matches the configured ' +
  'one). Neither index persisted the embed source, so a hash vector is indistinguishable from a ' +
  'real one — `filter:"all"` re-parses and re-embeds everything and is the only complete answer. ' +
  'Every reply carries that sentence as `caveat`. An unreachable parser or gateway is a typed ' +
  'ENGINE_UNAVAILABLE refusal and NOTHING is read, replaced or deleted — it never falls back to a ' +
  'stand-in, and a unit whose re-parse or re-embedding came back as one is reported failed with ' +
  'its existing rows left in place. Before: nothing. After: poll with mode:"run" (or ' +
  'mode:"plan") until done. Governance: admin re-checked in-lib at both doors; the embedding ' +
  'spend is billed to the acting admin with the object’s domain.';

export function reindexTools(services: ReindexServices): McpTool[] {
  return [
    {
      name: 'reindex_corpus',
      tab: 'files',
      // One tool, two corpora: `extraTabs` is exactly the mechanism the promotion tools use to
      // span data+files, so the Knowledge per-tab MCP view advertises it too.
      extraTabs: ['knowledge'],
      minRole: 'admin',
      description: DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string', enum: [...REINDEX_TARGETS], description: 'Which index: "files" or "knowledge".' },
          mode: {
            type: 'string',
            enum: ['plan', 'run', 'abandon'],
            description:
              '"plan" = dry run, writes nothing. "run" = one bounded batch (resumes a running job ' +
              'without re-planning). "abandon" = give up on the running job and free the target.',
          },
          filter: {
            type: 'string',
            enum: [...REINDEX_FILTERS],
            description:
              '"marked" = only units with detectable evidence (cheap, INCOMPLETE — see `caveat`). ' +
              '"all" = every unit (complete, and it spends real gateway budget).',
          },
          batch: { type: 'number', description: 'Units in this run call (default 25, max 200). Ignored by mode:"plan".' },
          status: { type: 'boolean', description: 'true = report the target’s current job and do nothing else.' },
        },
        required: ['target'],
        examples: [
          { target: 'files', mode: 'plan', filter: 'marked' },
          { target: 'knowledge', mode: 'run', filter: 'all', batch: 50 },
          { target: 'files', status: true },
          { target: 'files', mode: 'abandon' },
        ],
      },
      call: async (user, args) => {
        const target = str(args.target).trim();
        if (!isReindexTarget(target)) fail(`reindex_corpus needs target "files" or "knowledge" (got "${target}")`, 400);
        const service = services[target];
        if (!service) fail(`The ${target} tab is not enabled in this deployment, so its index cannot be re-indexed here.`, 409);

        // A pure status read: no plan, no probe, no write. The cheapest way to poll.
        if (bool(args.status)) {
          const job = jobFor(target);
          return {
            target,
            job: job ? jobPayload(job) : null,
            running: job?.status === 'running',
            // `inFlight` is the difference between "a batch is executing" and "a job is waiting
            // to be continued" — the distinction the panel's Continue depends on (review H2).
            inFlight: service.inFlight(),
          };
        }

        const mode = str(args.mode).trim() || 'plan';
        if (mode !== 'plan' && mode !== 'run' && mode !== 'abandon') {
          fail(`reindex_corpus needs mode "plan", "run" or "abandon" (got "${mode}")`, 400);
        }

        // ABANDON (review H3): no plan, no probe, no index write — it frees a target whose job
        // was left running by a killed process, which is otherwise unreachable from any door.
        if (mode === 'abandon') {
          const out = await service.abandonReindex(P(user));
          return {
            target,
            abandoned: out.abandoned,
            reason: out.reason ?? null,
            job: out.job ? jobPayload(out.job) : null,
          };
        }
        const rawFilter = str(args.filter).trim() || 'marked';
        if (!isReindexFilter(rawFilter)) fail(`reindex_corpus needs filter "marked" or "all" (got "${rawFilter}")`, 400);
        const filter: ReindexFilter = rawFilter;

        // RESUME without re-planning (review M4): one plan, then N cheap batches.
        const running = jobFor(target);
        if (mode === 'run' && running?.status === 'running') {
          const out = await service.runReindex(P(user), null, { batch: num(args.batch) || undefined });
          return {
            target,
            filter: out.job.filter,
            started: false,
            reason: out.reason ?? 'resumed',
            job: jobPayload(out.job),
          };
        }

        const plan = await service.planReindex(P(user), { filter });
        if (mode === 'plan') return planPayload(plan);

        if (!plan.ready) {
          // The plan already knows why, and it is not the caller's arguments.
          fail(`Cannot re-index ${target}: ${plan.blockedReason}`, 503);
        }
        if (plan.units.length === 0) {
          return { target, filter, started: false, reason: 'nothing-selected', job: null, plan: planPayload(plan) };
        }
        // The typed refusal from a mid-run engine failure is NOT caught: `structuredError` maps it.
        const out = await service.runReindex(P(user), plan, { batch: num(args.batch) || undefined });
        return {
          target,
          filter,
          started: out.started,
          reason: out.reason ?? null,
          job: jobPayload(out.job),
          counts: plan.counts,
          caveat: plan.unmarkedCaveat,
        };
      },
    },
  ];
}
