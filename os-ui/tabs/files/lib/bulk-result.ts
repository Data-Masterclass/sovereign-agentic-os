/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    One result formatter for every Files action that touches many files at once
 * USER STORY: As a Files owner I learn WHY a bulk action refused each file, in the server's own
 *             words, collapsed to one line per reason — and I am never told that "a domain admin
 *             approves each" when nothing was actually filed.
 * ARCHITECTURE:
 *   - Pure, `.ts`, no React: the browser's bulk path and the single-file preview both import it,
 *     so the two can no longer disagree about an error (ARCHITECTURE.md → "Diagnostics are a
 *     feature, and discarding them costs hours"). It is also why this is unit-testable at all —
 *     a test cannot import the `.tsx` that renders it.
 *   - `serverError` is the ONE place that knows the OS error envelope is `{ error: string }`.
 *     Every route in this tab answers with it (`core/kernel/route-server`), so a caller that
 *     reads `res.ok` alone is throwing away a sentence the server already wrote.
 *   - `summariseBulk` owns the notice GRAMMAR, including the half of the reported defect that
 *     was a governance claim: `approvalNote` is emitted only when at least one call succeeded.
 */

/**
 * One file's outcome in a bulk action. `error` is the server's text, never a paraphrase.
 *
 * `already` is the 200 that CHANGED NOTHING: the promote route answers a file whose request is
 * still pending with `{ approval, already: true }`. Counting that as a fresh request told a
 * user who pressed Promote twice that twelve more were filed when none were — the same
 * "a count is not a reason" defect one layer along (review M1).
 */
export type BulkOutcome = { id: string; name: string; ok: boolean; error?: string; already?: boolean };

/** Identical reasons, collapsed: "12 files: add a description, at least one tag first". */
export type ReasonGroup = { reason: string; count: number; names: string[] };

export type BulkSummary = {
  /** Calls that CHANGED something. For Promote this is requests FILED, not promotions
   *  applied — and never a request that was already pending before the press. */
  ok: number;
  /** Succeeded, but nothing happened because it was already in that state. */
  already: number;
  failed: number;
  /** Files the UI never attempted (not promotable / not the user's to manage / no change). */
  skipped: number;
  reasons: ReasonGroup[];
  /** The one line the selection toolbar shows. */
  notice: string;
};

/** The fixed lead-in the store writes in front of a gate refusal ("Cannot promote — …"). */
const LEAD_IN = /^cannot\s+[a-z]+\s*[—–-]\s*/i;

const NO_REASON = 'no reason given';

/**
 * The server's own error text out of a parsed JSON body, else `fallback`.
 * Defensive by design: the body may be `null`, a string, or an envelope whose `error` is
 * missing or not a string (a proxy or a 502 HTML page). Any of those is "no text" — the
 * caller's fallback — never a thrown exception inside an error path.
 */
export function serverError(body: unknown, fallback: string): string {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const raw = (body as { error?: unknown }).error;
    if (typeof raw === 'string' && raw.trim()) return raw.trim();
  }
  return fallback;
}

/**
 * The comparable core of a reason: drop the "Cannot promote — " lead-in and the trailing full
 * stop so twelve identical refusals collapse into ONE counted line. Anything that is not that
 * lead-in is left as the server wrote it — this normalises, it does not rewrite.
 */
export function shortReason(text: string): string {
  const out = text.trim().replace(LEAD_IN, '').replace(/\s*\.\s*$/, '').trim();
  return out || NO_REASON;
}

/**
 * Turn per-file outcomes into the notice. `verb` is the past participle of what succeeded
 * ("requested", "archived", "updated"); `approvalNote` is a governance sentence that is only
 * true when something was filed, so it is suppressed when `ok === 0`.
 */
export function summariseBulk(
  outcomes: BulkOutcome[],
  opts: { verb: string; skipped?: number; approvalNote?: string },
): BulkSummary {
  // A 200 that filed nothing is its own clause, never a success (review M1).
  const ok = outcomes.filter((o) => o.ok && !o.already).length;
  const already = outcomes.filter((o) => o.ok && o.already).length;
  const failures = outcomes.filter((o) => !o.ok);
  const skipped = opts.skipped ?? 0;

  const groups = new Map<string, ReasonGroup>();
  for (const f of failures) {
    const reason = shortReason(f.error ?? '');
    const g = groups.get(reason) ?? { reason, count: 0, names: [] };
    g.count += 1;
    g.names.push(f.name);
    groups.set(reason, g);
  }
  const reasons = [...groups.values()].sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));

  const counts = [ok > 0 ? `${ok} ${opts.verb}` : `Nothing ${opts.verb}`];
  if (already) counts.push(`${already} already pending`);
  if (failures.length) counts.push(`${failures.length} failed`);
  if (skipped) counts.push(`${skipped} skipped`);

  const sentences = [`${counts.join(' · ')}.`];
  // The approval claim is only true if a request really was filed BY THIS PRESS.
  if (ok > 0 && opts.approvalNote) sentences.push(opts.approvalNote);
  for (const g of reasons) {
    // With one casualty the NAME is the more useful fact; with several, the count is.
    const subject = g.count === 1 ? (g.names[0] || '1 file') : `${g.count} files`;
    sentences.push(`${subject}: ${g.reason}.`);
  }

  return { ok, already, failed: failures.length, skipped, reasons, notice: sentences.join(' ') };
}
