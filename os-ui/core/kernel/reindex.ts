/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The re-index CONTRACT — one shape for both corpora, and one job per target
 * USER STORY: As a platform admin re-indexing the Files and Knowledge indexes after the
 *             offline-mock outage, I want a plan I can read before I spend gateway budget, a run
 *             I can resume after an interrupted batch, and an absolute guarantee that pressing
 *             the button twice does not start two runs over the same corpus.
 * ARCHITECTURE:
 *   - CONTRACT IN THE KERNEL, IMPLEMENTATION IN THE TABS — exactly the split `core/manifest.ts`
 *     makes for `TabManifest`. The re-index SERVICES are tab-owned (`tabs/files/lib/reindex.ts`,
 *     `tabs/knowledge/lib/reindex.ts`): each corpus has its own parser, its own index mapping and
 *     its own unit of work, and a tab may not import another tab. What they share is the SHAPE
 *     (so one route, one MCP tool and one panel can serve both) and the JOB TABLE (so
 *     one-running-job-per-target is a single fact rather than two tabs' conventions that drift).
 *   - NO TAB IMPORT, and none possible: this module is types plus a `globalThis`-keyed map. It is
 *     the kernel, so it cannot know its tabs exist; the services depend on it, never the reverse.
 *   - THE JOB TABLE IS DELIBERATELY IN-PROCESS, keyed by `Symbol.for` like
 *     `tabs/files/lib/index-store.ts`'s index. A re-index is an operator act against the pod they
 *     are talking to, and a durable job record would promise cross-pod resumption this design
 *     does not provide. What IS durable is the index itself: a re-run is idempotent, so a lost
 *     job costs at most the batch in flight (see `cursor`).
 *   - HONESTY IS A FIELD, NOT A COMMENT. {@link ReindexPlan.unmarkedCaveat} carries the sentence
 *     that rows fabricated before the production guard and carrying no marker are not findable,
 *     so an agent reading the JSON and a person reading the panel are told the same thing.
 */
import { roleAtLeast, type Role } from '@core/kernel/session';

/** The two corpora PR #56 left debt in. A closed set — there is no third index with this debt. */
export const REINDEX_TARGETS = ['files', 'knowledge'] as const;
export type ReindexTarget = (typeof REINDEX_TARGETS)[number];
export function isReindexTarget(x: unknown): x is ReindexTarget {
  return typeof x === 'string' && (REINDEX_TARGETS as readonly string[]).includes(x);
}

/**
 * WHICH units a run processes.
 *   - `marked` — only units for which the plan found EVIDENCE (a persisted stand-in marker, a
 *     missing vector, a dimension mismatch, or no indexed row at all). Cheap, and incomplete by
 *     construction: see {@link UNMARKED_CAVEAT}.
 *   - `all` — every stored unit. The only complete answer, and the expensive one.
 */
export const REINDEX_FILTERS = ['marked', 'all'] as const;
export type ReindexFilter = (typeof REINDEX_FILTERS)[number];
export function isReindexFilter(x: unknown): x is ReindexFilter {
  return typeof x === 'string' && (REINDEX_FILTERS as readonly string[]).includes(x);
}

/**
 * The reasons a row or unit is suspect. Four are detectable; the fifth — a row fabricated before
 * the production guard that carries no marker — is NOT, which is why `all` exists.
 *
 *   marked                 a persisted `source`/`embed_source`/`mode` naming a stand-in
 *   missing-representation a stored unit with no row in the index at all (the parser produced
 *                         nothing, or the refusal stopped it before anything was written)
 *   missing-vector        a row with no embedding, or an empty one — invisible to k-NN while
 *                         looking exactly like corpus
 *   dimension-mismatch    the index mapping's knn dimension ≠ the configured one. OpenSearch
 *                         rejects a wrong-length vector at write time, so this is an INDEX-level
 *                         fact: when it holds, EVERY row is un-queryable
 *   all                   every row (the denominator, reported so the ratios are readable)
 */
export const REINDEX_REASONS = [
  'marked',
  'missing-representation',
  'missing-vector',
  'dimension-mismatch',
  'all',
] as const;
export type ReindexReason = (typeof REINDEX_REASONS)[number];

/** A zeroed count-per-reason map. A reason that is genuinely 0 is reported as 0, never omitted. */
export function zeroCounts(): Record<ReindexReason, number> {
  return { marked: 0, 'missing-representation': 0, 'missing-vector': 0, 'dimension-mismatch': 0, all: 0 };
}

/**
 * THE SENTENCE. Carried in every plan and repeated by every door, because the one thing an
 * operator must not conclude from a clean `marked` count is that the corpus is clean.
 */
export const UNMARKED_CAVEAT =
  'Rows written before the production guard while a parser or the embeddings gateway was ' +
  'unreachable carry NO marker: neither index persists the embed source, so a hash vector and a ' +
  'real vector are the same bytes in the same field. Those rows cannot be found by filter ' +
  '‘marked’ — only ‘all’ re-parses and re-embeds them. A marked count of 0 is not a clean bill ' +
  'of health.';

/** One unit of re-index work: a Files asset, a Knowledge workflow/domain card, or a pasted doc. */
export type ReindexUnit = {
  /** The unit key the service re-indexes by (a file id, a workflow id, `domain:<name>`, `doc:<id>`). */
  id: string;
  /** Human label for the panel and the failure list. */
  label: string;
  /** Why this unit is in the plan. `all` means "no specific evidence — the filter asked for it". */
  reasons: ReindexReason[];
  /** Rows the index currently holds for it (0 ⇒ missing-representation). */
  rows: number;
};

/** One engine the run needs, probed BEFORE anything is planned or written. */
export type EngineProbe = {
  name: string;
  url: string;
  ready: boolean;
  /** Why it is not ready, in the operator's words. Null when it is. */
  detail: string | null;
};

export type ReindexPlan = {
  target: ReindexTarget;
  filter: ReindexFilter;
  /**
   * ROW counts per reason — except `missing-representation`, which is a UNIT count, because a
   * unit with no indexed row has no rows to count. Said here rather than left for the reader to
   * infer, since the two numbers are not comparable.
   */
  counts: Record<ReindexReason, number>;
  units: ReindexUnit[];
  /** Rows in the index right now (the `all` count's row-level twin). */
  rowsTotal: number;
  /** The index mapping's knn dimension, or null when the index does not exist / was unreadable. */
  mappingDim: number | null;
  configuredDim: number;
  engines: EngineProbe[];
  /** Every engine ready ⇒ a run may start. The panel's Run button is this field. */
  ready: boolean;
  /** Why a run may not start, naming the engine. Null when `ready`. */
  blockedReason: string | null;
  /** Always {@link UNMARKED_CAVEAT}. A field so the honesty survives serialisation. */
  unmarkedCaveat: string;
  /** True when the unit list was capped — the run is still correct, it just needs more calls. */
  truncated: boolean;
};

/**
 * What one read of the target index found. The tab builds it (it owns the mapping, the field
 * names and the queries); {@link buildReindexPlan} turns it into a plan, so the CLASSIFICATION is
 * written and tested once instead of twice.
 */
export type IndexSnapshot = {
  /** False ⇒ the index itself could not be read. A plan over an unreadable index is not a plan. */
  reachable: boolean;
  rowsTotal: number;
  /** The knn field's mapping dimension; null when the index is absent or unreadable. */
  mappingDim: number | null;
  rowsMarked: number;
  rowsMissingVector: number;
  /** unit key → rows the index holds for it. */
  rowsByUnit: Map<string, number>;
  unitsMarked: Set<string>;
  unitsMissingVector: Set<string>;
  /** Rows that belong to no stored unit (a pasted Knowledge doc). Ids, capped. */
  looseDocs: { id: string; label: string }[];
  /** True when an enumeration hit its cap — the plan is still correct, just partial. */
  truncated: boolean;
};

/** A unit the tab's own store holds, independent of what the index says about it. */
export type StoredUnit = { id: string; label: string };

/** How many units one plan carries. A bigger corpus is several plan→run cycles, not one huge list. */
export const REINDEX_UNIT_CAP = 2000;

/**
 * Assemble the plan. PURE — no I/O, no clock, no randomness — so the classification that decides
 * what an operator is told (and billed for) is exhaustively testable, and identical for both
 * corpora.
 *
 * The three things it refuses to do:
 *   - it never reports `ready` while an engine is down, so the panel cannot offer a Run that
 *     would refuse;
 *   - it never treats an EMPTY STORE over a NON-EMPTY INDEX as "nothing to re-index". That is the
 *     shape of the September-2026 outage (a store hydrates empty without throwing, and an empty
 *     store looks exactly like a tenant that owns nothing); here it would have told an operator
 *     their corpus was clean while every poisoned row sat in the index. It blocks instead;
 *   - it never drops {@link UNMARKED_CAVEAT}.
 */
export function buildReindexPlan(input: {
  target: ReindexTarget;
  filter: ReindexFilter;
  engines: EngineProbe[];
  snapshot: IndexSnapshot;
  stored: StoredUnit[];
  configuredDim: number;
  unitCap?: number;
}): ReindexPlan {
  const { target, filter, engines, snapshot, stored, configuredDim } = input;
  const cap = input.unitCap ?? REINDEX_UNIT_CAP;
  const dimMismatch = snapshot.mappingDim !== null && snapshot.mappingDim !== configuredDim;

  const counts = zeroCounts();
  counts.all = snapshot.rowsTotal;
  counts.marked = snapshot.rowsMarked;
  counts['missing-vector'] = snapshot.rowsMissingVector;
  // Index-level, not row-level: OpenSearch rejects a wrong-length vector at write time, so when
  // the mapping disagrees with the configured dimension EVERY row is un-queryable.
  counts['dimension-mismatch'] = dimMismatch ? snapshot.rowsTotal : 0;

  const candidates: ReindexUnit[] = [];
  for (const u of [...stored, ...snapshot.looseDocs]) {
    const rows = snapshot.rowsByUnit.get(u.id) ?? 0;
    const reasons: ReindexReason[] = [];
    if (rows === 0) reasons.push('missing-representation');
    if (snapshot.unitsMarked.has(u.id)) reasons.push('marked');
    if (snapshot.unitsMissingVector.has(u.id)) reasons.push('missing-vector');
    if (dimMismatch && rows > 0) reasons.push('dimension-mismatch');
    candidates.push({ id: u.id, label: u.label, reasons, rows });
  }
  counts['missing-representation'] = candidates.filter((u) => u.reasons.includes('missing-representation')).length;

  const selected =
    filter === 'all'
      ? candidates.map((u) => (u.reasons.length ? u : { ...u, reasons: ['all' as ReindexReason] }))
      : candidates.filter((u) => u.reasons.length > 0);

  // The hydration guard, over CANDIDATES rather than over `stored`: a corpus whose only units
  // are loose index docs is a real corpus, and blocking it would be a false alarm.
  const unhydrated = candidates.length === 0 && snapshot.rowsTotal > 0;
  const down = engines.find((e) => !e.ready);
  const blockedReason = !snapshot.reachable
    ? 'The index could not be read, so there is nothing trustworthy to plan against.'
    : unhydrated
      ? `The index holds ${snapshot.rowsTotal} row(s) but no unit was found to re-index — either ` +
        'the durable mirror did not hydrate, or every unit those rows belonged to has been ' +
        'deleted. Refusing: an empty store is not evidence of a clean corpus.'
      : down
        ? `${down.name} is not reachable at ${down.url}${down.detail ? ` — ${down.detail}` : ''}.`
        : null;

  return {
    target,
    filter,
    counts,
    units: selected.slice(0, cap),
    rowsTotal: snapshot.rowsTotal,
    mappingDim: snapshot.mappingDim,
    configuredDim,
    engines,
    ready: blockedReason === null,
    blockedReason,
    unmarkedCaveat: UNMARKED_CAVEAT,
    truncated: snapshot.truncated || selected.length > cap,
  };
}

export type ReindexJobStatus = 'running' | 'done' | 'failed';

export type ReindexFailure = { unit: string; reason: string };

/** How many failures a job keeps. Enough to diagnose, bounded so a 10k-unit disaster cannot OOM. */
export const MAX_RECORDED_FAILURES = 50;

export type ReindexJob = {
  id: string;
  target: ReindexTarget;
  filter: ReindexFilter;
  status: ReindexJobStatus;
  /** Units the job was created for. */
  total: number;
  /** Units COMPLETED (replaced + failed + skipped). The resume point, and the progress bar. */
  cursor: number;
  replaced: number;
  failed: number;
  skipped: number;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  /** The admin who started it. */
  by: string;
  failures: ReindexFailure[];
  /** Set only when `status === 'failed'` — the reason the whole job stopped, not a unit's. */
  error: string | null;
};

/**
 * The re-index service each tab exposes. Structural, so a tab satisfies it without importing it
 * — and `core/mcp/reindex-tools.ts` builds the one `reindex_corpus` tool over a map of these,
 * which is how one tool can serve two tabs without the kernel importing either.
 */
export type ReindexService = {
  planReindex(principal: ReindexPrincipal, opts: { filter: ReindexFilter }): Promise<ReindexPlan>;
  runReindex(
    principal: ReindexPrincipal,
    plan: ReindexPlan,
    opts?: { batch?: number; onProgress?: (job: ReindexJob) => void | Promise<void> },
  ): Promise<{ started: boolean; job: ReindexJob; reason?: string }>;
};

/** Who is asking. The same shape every tab store calls `Principal`. */
export type ReindexPrincipal = { id: string; domains: string[]; role: Role };

/** Re-indexing a whole corpus is tenant-wide administration: admin, both doors, no exceptions. */
export function assertReindexAdmin(principal: ReindexPrincipal | null | undefined): void {
  if (!principal?.id || !roleAtLeast(principal.role, 'admin')) {
    const err = new Error('Re-indexing a corpus is admin-only') as Error & { status?: number };
    err.status = principal?.id ? 403 : 401;
    throw err;
  }
}

// ---------------------------------------------------------------------------
//  The job table — one running job per target, in process, cursor-resumable
// ---------------------------------------------------------------------------

const JOBS_KEY = Symbol.for('soa.reindex.jobs');
function jobs(): Map<ReindexTarget, ReindexJob> {
  const g = globalThis as unknown as Record<symbol, Map<ReindexTarget, ReindexJob> | undefined>;
  if (!g[JOBS_KEY]) g[JOBS_KEY] = new Map();
  return g[JOBS_KEY]!;
}

/** Test hook. */
export function __resetReindexJobs(): void {
  jobs().clear();
}

/** The target's most recent job — running, done or failed. Null when it has never been run. */
export function jobFor(target: ReindexTarget): ReindexJob | null {
  return jobs().get(target) ?? null;
}

/** Every known job, newest-first by start time. The panel's "what is going on" read. */
export function allReindexJobs(): ReindexJob[] {
  return [...jobs().values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

let seq = 0;
function jobId(target: ReindexTarget): string {
  seq += 1;
  return `rix_${target}_${Date.now().toString(36)}${seq.toString(36)}`;
}

/**
 * Claim the target's job slot.
 *
 * ONE RUNNING JOB PER TARGET: a `running` job for the target is RETURNED (`started: false`)
 * rather than replaced or rejected, so a second press — or a second agent — reports progress
 * instead of starting a twin over the same corpus. The two targets are independent: Files and
 * Knowledge may re-index at the same time, which is what an operator paying this debt down
 * actually wants.
 *
 * A job whose filter or total differs from the running one still returns the running job: the run
 * in flight is the fact, and "your request was not what is running" is said by comparing the
 * returned job's own fields rather than by a second, racing job.
 */
export function startOrResume(
  target: ReindexTarget,
  input: { filter: ReindexFilter; by: string; total: number },
  now: string = new Date().toISOString(),
): { started: boolean; job: ReindexJob } {
  const existing = jobs().get(target);
  if (existing && existing.status === 'running') return { started: false, job: existing };
  const job: ReindexJob = {
    id: jobId(target),
    target,
    filter: input.filter,
    status: 'running',
    total: input.total,
    cursor: 0,
    replaced: 0,
    failed: 0,
    skipped: 0,
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
    by: input.by,
    failures: [],
    error: null,
  };
  jobs().set(target, job);
  return { started: true, job };
}

/**
 * Record one completed unit. `cursor` only ever advances, and it advances for a FAILURE too: a
 * unit that could not be replaced must not be retried forever inside the same job, or a run over
 * a corpus with one bad document never finishes. The failure is kept (capped) so the operator can
 * see which units need attention, and a fresh `plan` + `run` retries them deliberately.
 */
export function recordUnit(
  target: ReindexTarget,
  outcome: 'replaced' | 'failed' | 'skipped',
  failure?: ReindexFailure,
  now: string = new Date().toISOString(),
): ReindexJob | null {
  const job = jobs().get(target);
  if (!job || job.status !== 'running') return null;
  job[outcome] += 1;
  job.cursor += 1;
  job.updatedAt = now;
  if (failure && job.failures.length < MAX_RECORDED_FAILURES) job.failures.push(failure);
  return job;
}

/**
 * Finish the target's running job. `done` when every unit was attempted; `failed` carries the
 * reason the JOB stopped (a refusal, an unreachable index) — which is a different fact from a
 * unit that failed, and is why `error` is separate from `failures`.
 */
export function finishJob(
  target: ReindexTarget,
  status: Exclude<ReindexJobStatus, 'running'>,
  error: string | null = null,
  now: string = new Date().toISOString(),
): ReindexJob | null {
  const job = jobs().get(target);
  if (!job) return null;
  job.status = status;
  job.error = error;
  job.updatedAt = now;
  job.finishedAt = now;
  return job;
}

/** Is there more to do? The caller loops on this, one bounded batch per call. */
export function jobRemaining(job: ReindexJob): number {
  return Math.max(0, job.total - job.cursor);
}

/** How many units this call should process: bounded, defaulted, never zero-or-negative. */
export const DEFAULT_REINDEX_BATCH = 25;
export const MAX_REINDEX_BATCH = 200;
export function batchSize(requested?: number): number {
  if (!Number.isFinite(requested) || !requested || requested <= 0) return DEFAULT_REINDEX_BATCH;
  return Math.min(Math.floor(requested), MAX_REINDEX_BATCH);
}
