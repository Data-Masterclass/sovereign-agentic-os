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
 * A success is not one thing. The promote route answers with exactly one of three
 * header-documented shapes, and each means something different to the person reading the
 * notice:
 *   `{ requested: true, promoted: false, approval }`        a request was FILED      → neither flag
 *   `{ requested: true, already: true, approvalId }`        one was already open     → `already`
 *   `{ promoted: true, requested: false, approvalId, … }`   the owner-approver's one → `promoted`
 *                                                            shot; already in the domain
 *
 * `already` is the 200 that CHANGED NOTHING — counting it as a fresh request told a user who
 * pressed Promote twice that twelve more were filed when none were (review M1). `promoted` is
 * the opposite error: a domain_admin/admin OWNER's file is already shared, so reporting it as
 * "requested … a domain admin approves each" would invent a step that has already happened.
 */
export type BulkOutcome = {
  id: string;
  name: string;
  ok: boolean;
  error?: string;
  already?: boolean;
  promoted?: boolean;
};

/** Identical reasons, collapsed: "12 files: add a description, at least one tag first". */
export type ReasonGroup = { reason: string; count: number; names: string[] };

export type BulkSummary = {
  /** Every call that CHANGED something: `requested + promoted`. Never one that was already
   *  pending before the press. */
  ok: number;
  /** Requests FILED by this press — the only count that puts work in an approver's queue. */
  requested: number;
  /** Applied outright by an owner who is also the approver (the one shot). */
  promoted: number;
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
  // The three success shapes are mutually exclusive and are counted apart: a one-shot
  // promotion is not a filed request (PR #61), and a 200 that filed nothing is neither
  // (review M1). `promoted` is tested first because it carries `requested: false`.
  const successes = outcomes.filter((o) => o.ok);
  const promoted = successes.filter((o) => o.promoted).length;
  const already = successes.filter((o) => !o.promoted && o.already).length;
  const requested = successes.filter((o) => !o.promoted && !o.already).length;
  const ok = requested + promoted;
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

  const counts: string[] = [];
  if (requested) counts.push(`${requested} ${opts.verb}`);
  if (promoted) counts.push(`${promoted} promoted`);
  // Nothing CHANGED — say so in the caller's own verb rather than leading with a refusal.
  if (counts.length === 0) counts.push(`Nothing ${opts.verb}`);
  if (already) counts.push(`${already} already pending`);
  if (failures.length) counts.push(`${failures.length} failed`);
  if (skipped) counts.push(`${skipped} skipped`);

  const sentences = [`${counts.join(' · ')}.`];
  // The approval claim is keyed on REQUESTED, not on success: a one-shot promotion is already
  // applied and an already-pending one was filed by an earlier press, so neither puts
  // anything new in front of an approver because of this one.
  if (requested > 0 && opts.approvalNote) sentences.push(opts.approvalNote);
  for (const g of reasons) {
    // With one casualty the NAME is the more useful fact; with several, the count is.
    const subject = g.count === 1 ? (g.names[0] || '1 file') : `${g.count} files`;
    sentences.push(`${subject}: ${g.reason}.`);
  }

  return { ok, requested, promoted, already, failed: failures.length, skipped, reasons, notice: sentences.join(' ') };
}
