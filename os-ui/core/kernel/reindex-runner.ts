/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The re-index RUN LOOP — plan, run a batch, resume, abandon — written once for both corpora
 * USER STORY: As a maintainer I want the Files and the Knowledge re-index to follow one loop, so a
 *             fix to "refuse before reading", "resume from the cursor" or "stop on abandon" lands
 *             in both corpora at once instead of in one copy and not the other.
 * ARCHITECTURE:
 *   - The tabs keep everything corpus-specific (which engines to probe, how to read the index,
 *     what a unit of work IS, the refusal sentence). They hand those in as {@link ReindexRunnerDeps}
 *     plus a {@link ReindexRunnerSpec} (including the typed refusal itself); this module owns only the target-agnostic control flow
 *     that `tabs/files/lib/reindex.ts` and `tabs/knowledge/lib/reindex.ts` used to carry as two
 *     identical copies. The kernel still imports no tab — the tabs call {@link createReindexRunner}.
 *   - Process state (the per-job work list and the one-batch-at-a-time flag) is keyed by
 *     `Symbol.for('soa.reindex.<target>.work|busy')`, the same keys the tab copies used, so a
 *     hot-reloaded module still sees the state of the module it replaced.
 *   - Also here: the four small OpenSearch read helpers both snapshots use ({@link osJson},
 *     {@link countOf}, {@link bucketsOf}, {@link mappingDimension}) and the engine probe.
 *   - The guarantees, in order of the code: refuse BEFORE reading anything when an engine is
 *     down; a resume (`plan === null`) never re-plans; a lost work list fails the job instead of
 *     indexing against the wrong list; an abandon or a new job stops the batch at the next unit.
 */
import { config } from '@core/kernel/config';
import {
  assertReindexAdmin,
  batchSize,
  buildReindexPlan,
  finishJob,
  jobFor,
  jobRemaining,
  recordUnit,
  startOrResume,
  type EngineProbe,
  type IndexSnapshot,
  type ReindexFilter,
  type ReindexJob,
  type ReindexPlan,
  type ReindexPrincipal,
  type ReindexService,
  type ReindexTarget,
  type ReindexUnit,
  type StoredUnit,
} from '@core/kernel/reindex';

/** What re-indexing ONE unit came to. `failed`/`skipped` carry a reason for the job's failure list. */
export type UnitOutcome = { outcome: 'replaced' | 'failed' | 'skipped'; reason?: string };

/** The corpus-specific seam: injectable so the loop is unit-testable without a cluster. */
export type ReindexRunnerDeps = {
  probeEngines: () => Promise<EngineProbe[]>;
  readSnapshot: () => Promise<IndexSnapshot>;
  storedUnits: () => StoredUnit[] | Promise<StoredUnit[]>;
  reindexUnit: (unitId: string, by: string) => Promise<UnitOutcome>;
};

export type ReindexRunnerSpec = {
  target: ReindexTarget;
  /** The live defaults. A getter, so the tab can define them after the functions they point at. */
  liveDeps: () => ReindexRunnerDeps;
  /** The embedding dimension the plan compares the index mapping against. */
  configuredDim: () => number;
  /**
   * Refuse a run because `down` is unreachable. MUST throw — the tabs call `refuseOfflineMock`,
   * the house-typed ENGINE_UNAVAILABLE (503) — and its message must say nothing was touched. It
   * is the tab's call, not the runner's, so each corpus's refusal (and its wording) stays in the
   * file that owns the corpus, where the source tripwires in its test look for it.
   */
  refuse: (down: EngineProbe) => never;
};

export type ReindexRunner = {
  planReindex(principal: ReindexPrincipal, opts: { filter: ReindexFilter; deps?: ReindexRunnerDeps }): Promise<ReindexPlan>;
  runReindex(
    principal: ReindexPrincipal,
    plan: ReindexPlan | null,
    opts?: { batch?: number; onProgress?: (job: ReindexJob) => void | Promise<void>; deps?: ReindexRunnerDeps },
  ): Promise<{ started: boolean; job: ReindexJob; reason?: string }>;
  abandonReindex(principal: ReindexPrincipal): Promise<{ abandoned: boolean; job: ReindexJob | null; reason?: string }>;
  inFlight(): boolean;
  /** Test hook — the work list and the busy flag are process state, like the index itself. */
  reset(): void;
  service: ReindexService;
};

export function createReindexRunner(spec: ReindexRunnerSpec): ReindexRunner {
  const { target } = spec;

  /** The work list a resume needs: the ORIGINAL unit order, not whatever a later plan computed. */
  const WORK_KEY = Symbol.for(`soa.reindex.${target}.work`);
  const workList = (): Map<string, ReindexUnit[]> => {
    const g = globalThis as unknown as Record<symbol, Map<string, ReindexUnit[]> | undefined>;
    if (!g[WORK_KEY]) g[WORK_KEY] = new Map();
    return g[WORK_KEY]!;
  };

  /** One batch at a time per target, so two concurrent callers cannot process the same units. */
  const BUSY_KEY = Symbol.for(`soa.reindex.${target}.busy`);
  const busy = (set?: boolean): boolean => {
    const g = globalThis as unknown as Record<symbol, boolean | undefined>;
    if (set !== undefined) g[BUSY_KEY] = set;
    return Boolean(g[BUSY_KEY]);
  };

  async function planReindex(
    principal: ReindexPrincipal,
    opts: { filter: ReindexFilter; deps?: ReindexRunnerDeps },
  ): Promise<ReindexPlan> {
    assertReindexAdmin(principal);
    const deps = opts.deps ?? spec.liveDeps();
    // A plan WRITES NOTHING and is readable during the very outage that caused the damage, which
    // is when an operator most wants to know how bad it is. The engines are probed so the panel
    // can disable Run with a reason — not so the plan can refuse.
    const [engines, snapshot, stored] = await Promise.all([
      deps.probeEngines(),
      deps.readSnapshot(),
      deps.storedUnits(),
    ]);
    return buildReindexPlan({ target, filter: opts.filter, engines, snapshot, stored, configuredDim: spec.configuredDim() });
  }

  async function runReindex(
    principal: ReindexPrincipal,
    plan: ReindexPlan | null,
    opts: { batch?: number; onProgress?: (job: ReindexJob) => void | Promise<void>; deps?: ReindexRunnerDeps } = {},
  ): Promise<{ started: boolean; job: ReindexJob; reason?: string }> {
    assertReindexAdmin(principal);
    const deps = opts.deps ?? spec.liveDeps();

    // REFUSE BEFORE READING ANYTHING. The probe is the first statement that can fail, so a
    // refusal provably touches no row — which is the one promise this tool cannot afford to break.
    const down = (await deps.probeEngines()).find((e) => !e.ready);
    if (down) spec.refuse(down);

    const existing = jobFor(target);
    if (existing?.status === 'running' && busy()) {
      return { started: false, job: existing, reason: 'already-running' };
    }

    // RESUME (`plan === null`): no re-plan, no second index read — the running job's own work list
    // and cursor are the facts (review M4). Nothing to resume is a stated conflict, not a silent
    // no-op, because the caller believed there was a job.
    if (!plan && (!existing || existing.status !== 'running')) {
      const err = new Error(
        `There is no running ${target} re-index to continue. Run a plan first, then start one.`,
      ) as Error & { status?: number };
      err.status = 409;
      throw err;
    }

    const claim = plan
      ? startOrResume(target, { filter: plan.filter, by: principal.id, total: plan.units.length })
      : { started: false, job: existing! };
    const job = claim.job;
    if (claim.started && plan) workList().set(job.id, plan.units);

    // A resume uses the list the job was CREATED with. If that list is GONE — the process was
    // replaced between batches — the cursor would index into a different list, so the units it
    // points past would silently never be re-indexed while the job reported progress. The job
    // FAILS instead (review low 4); a fresh plan + run redoes the work, which is idempotent.
    const work = workList().get(job.id);
    if (!work) {
      const dead = finishJob(
        target,
        'failed',
        'The work list for this job was lost (the process was replaced between batches), so its ' +
          'cursor no longer points into a known list. Nothing was indexed against it. Run Plan ' +
          'again and start a fresh re-index — re-indexing is idempotent.',
      );
      return { started: false, job: dead ?? job, reason: 'work-list-lost' };
    }

    busy(true);
    try {
      for (const unit of work.slice(job.cursor, job.cursor + batchSize(opts.batch))) {
        // An ABANDON — or another job claiming the slot after one — stops the batch at the next
        // unit boundary. The guard compares the JOB ID, not just the status (re-review M): after
        // an abandon frees the slot a NEW job may already hold it.
        const current = jobFor(target);
        if (!current || current.id !== job.id || current.status !== 'running') break;
        let out: UnitOutcome;
        try {
          out = await deps.reindexUnit(unit.id, principal.id);
        } catch (e) {
          // An engine that went away mid-run, or a gateway rejection. The cursor stays where the
          // work stopped, so the next call resumes; the typed error reaches the caller unchanged.
          finishJob(target, 'failed', (e as Error).message);
          workList().delete(job.id);
          throw e;
        }
        // The job this loop belongs to — never "whatever holds the slot now". See `recordUnit`.
        recordUnit(
          target,
          job.id,
          out.outcome,
          out.outcome === 'replaced' ? undefined : { unit: unit.label, reason: out.reason ?? 'no reason given' },
        );
        const progressed = jobFor(target);
        // AWAITED: a progress callback may itself be async (a UI flush, a re-entrant status read).
        if (progressed && opts.onProgress) await opts.onProgress(progressed);
      }
      const after = jobFor(target)!;
      if (after.status === 'running' && jobRemaining(after) === 0) {
        finishJob(target, 'done');
        workList().delete(job.id);
      }
      return { started: claim.started, job: jobFor(target)!, reason: claim.started ? undefined : 'resumed' };
    } finally {
      busy(false);
    }
  }

  /**
   * ABANDON the target's running job (review H3) — the only way out of a job whose process died
   * between batches. It marks the job FAILED and names who abandoned it rather than deleting it;
   * nothing in the index is touched or rolled back.
   */
  async function abandonReindex(
    principal: ReindexPrincipal,
  ): Promise<{ abandoned: boolean; job: ReindexJob | null; reason?: string }> {
    assertReindexAdmin(principal);
    const job = jobFor(target);
    if (!job || job.status !== 'running') {
      busy(false); // a stale flag with no running job is exactly what this door exists to clear
      return { abandoned: false, job, reason: 'nothing-running' };
    }
    const failed = finishJob(target, 'failed', `Abandoned by ${principal.id} at ${job.cursor}/${job.total}. ` +
      'The units already replaced are replaced; the rest were not touched. Plan again to redo them.');
    workList().delete(job.id);
    busy(false);
    return { abandoned: true, job: failed ?? job };
  }

  /** Is a batch executing right now? Exposed so the panel can tell "running" from "busy" (H2). */
  const inFlight = (): boolean => busy();

  const reset = (): void => {
    workList().clear();
    busy(false);
  };

  return { planReindex, runReindex, abandonReindex, inFlight, reset, service: { planReindex, runReindex, abandonReindex, inFlight } };
}

// ---------------------------------------------------------------------------
//  Small OpenSearch + engine helpers both corpora's snapshot readers use
// ---------------------------------------------------------------------------

/** A parsed OpenSearch reply, or `null` for a transport failure / timeout. */
export type OsReply = { status: number; body: Record<string, unknown> } | null;

/** One OpenSearch JSON call. `null` means unreachable — NOT the same fact as "the index is empty". */
export async function osJson(path: string, init?: RequestInit, ms = 6000): Promise<OsReply> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(`${config.opensearchUrl}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', accept: 'application/json', ...(init?.headers ?? {}) },
      signal: ctrl.signal,
      cache: 'no-store',
    });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      body = {};
    }
    return { status: res.status, body };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** `_count` reply → the number, 0 when absent. */
export function countOf(reply: OsReply): number {
  const n = reply?.body?.count;
  return typeof n === 'number' ? n : 0;
}

/** The buckets of the `units` terms aggregation, [] when absent. */
export function bucketsOf(reply: OsReply): { key: string; doc_count: number }[] {
  const aggs = (reply?.body?.aggregations ?? {}) as Record<string, { buckets?: unknown }>;
  const raw = aggs.units?.buckets;
  return Array.isArray(raw) ? (raw as { key: string; doc_count: number }[]) : [];
}

/** Pull the knn field's dimension out of a `_mapping` body (keyed by the concrete index name). */
export function mappingDimension(body: Record<string, unknown>, field: string): number | null {
  for (const entry of Object.values(body)) {
    const props = (entry as { mappings?: { properties?: Record<string, { dimension?: unknown }> } })?.mappings?.properties;
    const dim = props?.[field]?.dimension;
    if (typeof dim === 'number') return dim;
  }
  return null;
}

/** GET a health URL with a 2.5 s budget and report it as an {@link EngineProbe}. */
export async function probeEngine(name: string, url: string): Promise<EngineProbe> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  try {
    const res = await fetch(url, { method: 'GET', signal: ctrl.signal, cache: 'no-store' });
    return { name, url, ready: res.ok, detail: res.ok ? null : `HTTP ${res.status}` };
  } catch (e) {
    return { name, url, ready: false, detail: (e as Error).message || 'no response' };
  } finally {
    clearTimeout(timer);
  }
}
