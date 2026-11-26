/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The Re-index panel's view model and its copy — Plan → counts → Run → progress
 * USER STORY: As a platform admin I want the panel to tell me what is wrong with each index, to
 *             refuse to offer me a Run it knows would fail and say which component is down, and
 *             to be explicit that a clean "marked" count is NOT a clean corpus.
 * ARCHITECTURE:
 *   - A `.ts` sibling of `tabs/admin/ui/ReindexSection.tsx`, because a test cannot import a
 *     `.tsx` (Node strips types but not JSX) — the pattern `tabs/admin/lib/sections.ts` and
 *     `core/ui/account-menu.ts` set. Every sentence an operator could mis-read lives here, under
 *     test; the component renders it and owns no copy of its own.
 *   - PURE: no fetch, no React, no clock. The panel passes in the plan and the job it last read.
 *   - I18N: the English strings stay the exports tests read; the panel renders the catalog `admin.reindex.*`
 *     through the codes and `REASON_KEY` here (`runDisabledCode`, `abandonDisabledCode`), never a second copy
 *     of the predicates.
 *   - The disabled-reason is computed in ONE place and used for both the button's `disabled` and
 *     its `title`, so a disabled control can never be silent about why.
 */
import {
  REINDEX_REASONS,
  type ReindexJob,
  type ReindexPlan,
  type ReindexReason,
  type ReindexTarget,
} from '@core/kernel/reindex';

export type ReindexTargetView = { id: ReindexTarget; label: string; sub: string };

/** The two corpora, as the panel names them. */
export const REINDEX_TARGET_VIEWS: ReindexTargetView[] = [
  {
    id: 'files',
    label: 'Files index',
    sub: 'Re-parses each file with Docling and re-embeds every chunk through the gateway.',
  },
  {
    id: 'knowledge',
    label: 'Knowledge index',
    sub: 'Re-chunks each workflow and domain card and re-embeds it; pasted documents are re-embedded in place.',
  },
];

/** The per-reason row labels. Short enough for a table, specific enough to act on. */
export const REASON_LABELS: Record<ReindexReason, string> = {
  marked: 'Rows that still admit to being a stand-in',
  'missing-representation': 'Units with no indexed row at all',
  'missing-vector': 'Rows with no embedding',
  'dimension-mismatch': 'Rows whose dimension no longer matches',
  all: 'Rows in the index',
};

/** Catalog leaf per reason, for `admin.reindex.reasons.<key>.label|help` (the UI's translated copy). */
export const REASON_KEY = {
  marked: 'marked',
  'missing-representation': 'missingRepresentation',
  'missing-vector': 'missingVector',
  'dimension-mismatch': 'dimensionMismatch',
  all: 'all',
} as const satisfies Record<ReindexReason, string>;

/** What each number means — shown as the row's help text, because a count alone misleads. */
export const REASON_HELP: Record<ReindexReason, string> = {
  marked:
    'A persisted label (source / embed_source / mode) naming a stand-in. No writer in EITHER ' +
    'index ever stamped one — Knowledge has a `source` field, but it holds provenance like ' +
    '`os-ui-ingest` — so 0 here is expected and proves nothing.',
  'missing-representation':
    'A stored file or workflow the index holds nothing for — the parser produced nothing, or a ' +
    'refusal stopped it. Counted in UNITS, not rows: there are no rows to count.',
  'missing-vector':
    'Indexed text with no vector, so it can never be found by similarity search. Pasted ' +
    'documents are written this way today.',
  'dimension-mismatch':
    'The index mapping’s knn dimension differs from the configured one. OpenSearch rejects a ' +
    'wrong-length vector at write time, so when this is non-zero EVERY row is un-queryable.',
  all: 'The denominator, so the other counts can be read as proportions.',
};

/**
 * THE SENTENCE THE PANEL MUST NOT LOSE. The plan carries its own `unmarkedCaveat`; this is the
 * panel's framing of the same fact, beside the filter control where the choice is actually made.
 */
export const MARKED_VS_ALL_COPY =
  'Re-index marked only finds rows that still carry evidence. Rows fabricated before the ' +
  'production guard carry none — a hash vector and a real vector are the same bytes in the same ' +
  'field — so a marked count of 0 is not a clean bill of health. Re-index everything is the only ' +
  'complete answer, and it spends real gateway budget.';

/**
 * Why the Run button is disabled, or null when it is not. ONE computation, two uses (the
 * `disabled` prop and the `title`), so a disabled control is never silent about why.
 *
 * REVIEW H2: this used to disable on `job.status === 'running'`, which greyed Continue out in
 * exactly the state that needs it — a job left half-done by an interrupted polling loop, a closed
 * tab or a failed batch is `running` with NOTHING in flight, and that is precisely when an
 * operator must be able to continue it. The gate is `inFlight` (the server's own `busy()` flag,
 * read from `GET /api/platform-admin/reindex`): a batch is executing *right now*. A running job
 * with no batch in flight is CONTINUABLE, and needs no plan — the job's own work list and cursor
 * are the facts.
 */
export type RunDisabledCode = 'busy' | 'inFlight' | 'noPlan' | 'blocked' | 'notReady' | 'empty';

/** The ONE computation behind the Run button's state; `blocked` means show `plan.blockedReason` (server text). */
export function runDisabledCode(
  plan: ReindexPlan | null,
  job: ReindexJob | null,
  busy = false,
  inFlight = false,
): RunDisabledCode | null {
  if (busy) return 'busy';
  if (inFlight) return 'inFlight';
  if (job?.status === 'running') return null; // continuable: no plan needed, the cursor is the fact
  if (!plan) return 'noPlan';
  if (!plan.ready) return plan.blockedReason ? 'blocked' : 'notReady';
  if (plan.units.length === 0) return 'empty';
  return null;
}

export function runDisabledReason(
  plan: ReindexPlan | null,
  job: ReindexJob | null,
  busy = false,
  inFlight = false,
): string | null {
  switch (runDisabledCode(plan, job, busy, inFlight)) {
    case null: return null;
    case 'busy': return 'A request is in flight.';
    case 'inFlight': return 'A batch of this re-index is running right now — it will continue on its own.';
    case 'noPlan': return 'Run Plan first — a re-index should never start before you have read what it would do.';
    case 'blocked': return plan?.blockedReason ?? null;
    case 'notReady': return 'This index cannot be re-indexed right now.';
    case 'empty': return 'Nothing selected: this filter found no unit to re-index.';
  }
}

export type AbandonDisabledCode = 'busy' | 'notRunning' | 'inFlight';

/** Why Abandon is disabled, as a code, or null. Only a running job that is not mid-batch may be abandoned. */
export function abandonDisabledCode(job: ReindexJob | null, busy = false, inFlight = false): AbandonDisabledCode | null {
  if (busy) return 'busy';
  if (!job || job.status !== 'running') return 'notRunning';
  if (inFlight) return 'inFlight';
  return null;
}

/** Why Abandon is disabled, or null. Only a running job that is not mid-batch may be abandoned. */
export function abandonDisabledReason(job: ReindexJob | null, busy = false, inFlight = false): string | null {
  switch (abandonDisabledCode(job, busy, inFlight)) {
    case null: return null;
    case 'busy': return 'A request is in flight.';
    case 'notRunning': return 'Nothing is running.';
    case 'inFlight': return 'A batch is executing right now — wait for it to finish, then abandon.';
  }
}

/** The batch sizes the panel offers. Bounded by `MAX_REINDEX_BATCH`; the default is the middle. */
export const BATCH_CHOICES = [10, 25, 50, 100, 200] as const;

/**
 * What a run is about to cost, in the operator's terms — units, rows and how many POSTs the panel
 * will make at the chosen batch size (review M4: the first version looped up to 500 requests with
 * no estimate and no confirmation, and never sent a batch size at all).
 */
export function runEstimate(plan: ReindexPlan | null, batch: number): { units: number; rows: number; batches: number; text: string } {
  const units = plan?.units.length ?? 0;
  const rows = plan?.units.reduce((n, u) => n + u.rows, 0) ?? 0;
  const batches = units === 0 ? 0 : Math.ceil(units / Math.max(1, batch));
  const text =
    units === 0
      ? 'Nothing selected.'
      : `${units} unit(s) covering ${rows} indexed row(s), in ${batches} batch(es) of up to ${batch}. ` +
        'Every selected unit is re-parsed and re-embedded through the real services, which costs real gateway budget.';
  return { units, rows, batches, text };
}

/**
 * The sentence the panel must make the operator confirm before `all`. `all` re-does the WHOLE
 * corpus, including every row that is perfectly fine, so it is the one choice here that spends
 * budget it may not need to — the operator should be told the number before, not after.
 */
export function confirmRunText(plan: ReindexPlan, batch: number): string | null {
  if (plan.filter !== 'all') return null;
  const est = runEstimate(plan, batch);
  return `Re-index EVERYTHING in the ${plan.target} index: ${est.text} Rows that are already correct will be re-parsed and re-embedded too. Continue?`;
}

/** The label on the primary action, which changes meaning once a job exists. */
export function runButtonLabel(job: ReindexJob | null): string {
  if (job?.status === 'running') return `Continue (${job.cursor}/${job.total})`;
  return 'Run re-index';
}

export type ReasonRow = { reason: ReindexReason; label: string; help: string; count: number; unit: 'rows' | 'units' };

/** The counts table, in a fixed order, with every reason present even at zero. */
export function reasonRows(plan: ReindexPlan): ReasonRow[] {
  return REINDEX_REASONS.map((reason) => ({
    reason,
    label: REASON_LABELS[reason],
    help: REASON_HELP[reason],
    count: plan.counts[reason],
    unit: reason === 'missing-representation' ? 'units' : 'rows',
  }));
}

/** One line of progress, honest about failures and about what is left. */
export function progressLabel(job: ReindexJob | null): string {
  if (!job) return 'Not run yet.';
  const left = Math.max(0, job.total - job.cursor);
  const head =
    job.status === 'running'
      ? `Running — ${job.cursor} of ${job.total} done, ${left} to go`
      : job.status === 'done'
        ? `Finished — ${job.cursor} of ${job.total} units`
        : `Stopped — ${job.cursor} of ${job.total} units, then it failed`;
  const parts = [`${job.replaced} replaced`];
  if (job.failed) parts.push(`${job.failed} failed`);
  if (job.skipped) parts.push(`${job.skipped} skipped`);
  return `${head}: ${parts.join(' · ')}.`;
}

/** The engine rows under the Plan button, so "why can I not run this" is always on screen. */
export function engineLines(plan: ReindexPlan | null): { name: string; ok: boolean; text: string }[] {
  if (!plan) return [];
  return plan.engines.map((e) => ({
    name: e.name,
    ok: e.ready,
    text: e.ready ? `reachable at ${e.url}` : `NOT reachable at ${e.url}${e.detail ? ` — ${e.detail}` : ''}`,
  }));
}
