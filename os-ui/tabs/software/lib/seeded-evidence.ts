/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    A `demo-seed` result is STRUCTURALLY UNUSABLE as governance evidence
 * USER STORY: As an approver I must never be shown a green review card, a passing gate or a
 *             `verify_software` verdict that was computed over seeded placeholder data — an
 *             approval grounded in seeded data is a governance failure wearing a green tick
 *             (night-2 S3, decision D22(b)).
 * ARCHITECTURE:
 *   - Today a non-record app tool answers from the live app pod (`source: 'live-app'`) or, when
 *     no runner is up, from deterministic placeholder rows HONESTLY LABELLED
 *     `source: 'demo-seed'` + `note` (`tool-exec.ts`). The label is right — but it lives in a
 *     RESPONSE FIELD that a UI, an agent or a card builder can simply drop, and then the seed
 *     reads as the app's real answer.
 *   - So the label is made STRUCTURAL at the gate boundary instead of advisory at the edge:
 *     `assertNotSeeded(context, value)` deep-scans a candidate piece of evidence for the seed
 *     marker and throws a typed 409 naming the context. It is called where a DECISION is made —
 *     requesting a deploy, deciding a deploy, and the verify verdict — so a seeded value cannot
 *     reach an approval at all, whatever any caller forgets to check.
 *   - Pure: no server imports, no I/O, bounded recursion, cycle-safe. Unit-testable alone.
 *   - It REFUSES; it never strips. Silently removing the seed would leave the gate running over
 *     a hole and reporting success — exactly the failure mode this exists to prevent.
 */
import { DEMO_SEED_NOTE } from '@tabs/software/lib/tool-exec';

/** The one marker value every seeded result carries in its `source` field. */
export const SEEDED_SOURCE = 'demo-seed';

/** How deep the scan walks. Evidence is a card, a scan result or a file list — never deeper. */
export const MAX_SCAN_DEPTH = 8;

/** The typed refusal. 409, because the request is well-formed but the EVIDENCE is unusable. */
export class SeededEvidenceError extends Error {
  readonly code = 'seeded_evidence';
  readonly status = 409;
  readonly context: string;
  constructor(context: string) {
    super(
      `Refusing to use demo-seed data as evidence for ${context}. ` +
        'A `demo-seed` result is placeholder data produced because the app runner was not live — ' +
        'it is not a response from the app. Start the app (or its preview) so the gate runs against ' +
        'the real application, then try again. Nothing was approved, recorded or changed.',
    );
    this.name = 'SeededEvidenceError';
    this.context = context;
  }
}

/**
 * Does this value carry the demo-seed marker anywhere a gate would read it?
 * Matches `source: 'demo-seed'` (the label `tool-exec.ts` sets) and the seed NOTE text, so a
 * caller that forwarded only the human note is caught too. Cycle-safe and depth-bounded.
 */
export function isSeededEvidence(value: unknown, depth = 0, seen = new WeakSet<object>()): boolean {
  if (depth > MAX_SCAN_DEPTH) return false;
  if (typeof value === 'string') return value === SEEDED_SOURCE || value.includes(DEMO_SEED_NOTE);
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value as object)) return false;
  seen.add(value as object);
  if (Array.isArray(value)) return value.some((v) => isSeededEvidence(v, depth + 1, seen));
  const rec = value as Record<string, unknown>;
  if (rec.source === SEEDED_SOURCE || rec.mode === SEEDED_SOURCE) return true;
  return Object.values(rec).some((v) => isSeededEvidence(v, depth + 1, seen));
}

/**
 * Refuse `value` as evidence for `context` when it is seeded. Call this at every point where a
 * DECISION is taken over evidence: the gate, the review card, the approval, the verify verdict.
 */
export function assertNotSeeded(context: string, value: unknown): void {
  if (isSeededEvidence(value)) throw new SeededEvidenceError(context);
}
