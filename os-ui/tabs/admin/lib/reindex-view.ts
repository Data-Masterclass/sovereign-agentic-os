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

/** What each number means — shown as the row's help text, because a count alone misleads. */
export const REASON_HELP: Record<ReindexReason, string> = {
  marked:
    'A persisted label (source / embed_source / mode) naming a stand-in. The Files index never ' +
    'carried such a field, so 0 here is expected and proves nothing.',
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

/** Why the Run button is disabled, or null when it is not. ONE computation, two uses. */
export function runDisabledReason(plan: ReindexPlan | null, job: ReindexJob | null, busy = false): string | null {
  if (busy) return 'A request is in flight.';
  if (job?.status === 'running') return `A re-index of this index is already running (${job.cursor}/${job.total} done). Continue it instead.`;
  if (!plan) return 'Run Plan first — a re-index should never start before you have read what it would do.';
  if (!plan.ready) return plan.blockedReason ?? 'This index cannot be re-indexed right now.';
  if (plan.units.length === 0) return 'Nothing selected: this filter found no unit to re-index.';
  return null;
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
