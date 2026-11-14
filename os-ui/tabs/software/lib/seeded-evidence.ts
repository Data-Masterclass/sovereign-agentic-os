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
 *   - REVIEW M-4: the rule is POSITIVE. Scanning for the negative marker `demo-seed` meant any
 *     new execution path that forgot to label itself — or any caller that dropped the label —
 *     passed. Now a value whose `source`/`provenance` claims anything must claim `live-app`, and
 *     anything else is refused by default rather than by enumeration. The axis matters: `mode`
 *     (which ENGINE ran) is not this axis — see {@link PROVENANCE_KEYS}.
 */
import { DEMO_SEED_NOTE } from '@tabs/software/lib/tool-exec';

/** The one value that means "this came from the real application". */
export const LIVE_SOURCE = 'live-app';
/** The marker a seeded result carries. Kept for the legacy negative check below. */
export const SEEDED_SOURCE = 'demo-seed';

/** How deep the scan walks. Evidence is a card, a scan result or a file list — never deeper. */
export const MAX_SCAN_DEPTH = 8;

/** The typed refusal. 409, because the request is well-formed but the EVIDENCE is unusable. */
export class SeededEvidenceError extends Error {
  readonly code = 'seeded_evidence';
  readonly status = 409;
  readonly context: string;
  constructor(context: string, detail: string) {
    super(
      `Refusing to use this result as evidence for ${context}: ${detail} ` +
        'Start the app (or its preview) so the gate runs against the real application, then try ' +
        'again. Nothing was approved, recorded or changed.',
    );
    this.name = 'SeededEvidenceError';
    this.context = context;
  }
}

/**
 * Does this value carry the demo-seed marker anywhere a gate would read it? Retained as a
 * BACKSTOP for values that predate the provenance rule. It is not the gate — see
 * {@link assertNotSeeded}, which requires positive provenance instead.
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
 * The keys that carry the APP-ANSWER axis: "did the real application produce this, or did
 * something stand in for it?" `executeAppTool` / `tool-exec.ts` set `source` to `live-app` or
 * `demo-seed`, and that is the axis this guard governs.
 *
 * `mode` is DELIBERATELY NOT one of them. `mode` is a different axis — WHICH ENGINE ran — and a
 * review card legitimately carries `scan.mode: 'offline-mock'`: a real, deterministic security
 * scan over the real committed files, by the offline engine. Refusing that would block every
 * offline gate, which is both wrong and the fastest way to get a guard switched off. A
 * `mode: 'demo-seed'` is still caught, by the negative backstop below.
 */
const PROVENANCE_KEYS = ['source', 'provenance'] as const;

/**
 * Every value inside `root` that CLAIMS an app-answer provenance. Cycle-safe and depth-bounded.
 * This is what the positive rule inspects: a claim must say `live-app`, and a value with no
 * claim at all is not an app answer and is not what this guard is about.
 */
export function provenanceClaims(value: unknown, depth = 0, seen = new WeakSet<object>(), out: string[] = []): string[] {
  if (depth > MAX_SCAN_DEPTH || !value || typeof value !== 'object') return out;
  if (seen.has(value as object)) return out;
  seen.add(value as object);
  if (Array.isArray(value)) {
    for (const v of value) provenanceClaims(v, depth + 1, seen, out);
    return out;
  }
  const rec = value as Record<string, unknown>;
  for (const key of PROVENANCE_KEYS) {
    const v = rec[key];
    if (typeof v === 'string' && v) out.push(v);
  }
  for (const v of Object.values(rec)) provenanceClaims(v, depth + 1, seen, out);
  return out;
}

/**
 * POSITIVE PROVENANCE (review M-4). A gate, a review card or a verify verdict may be grounded
 * ONLY in a result that SAYS it came from the real application.
 *
 * The earlier rule scanned for the negative marker `demo-seed`, which is the wrong way round: a
 * new execution path that forgets to label itself, or a caller that strips the label, would sail
 * through a negative check. So the rule is inverted — any value that claims a provenance at all
 * must claim `live-app`, and an unrecognised claim (including a future `offline-mock`,
 * `cached`, `simulated`, …) is refused BY DEFAULT rather than by enumeration.
 *
 * A value that claims nothing — a file list, a diff, a scan result — is not a provenance-bearing
 * result and is not what this guard is about; it passes. The guard exists to stop a RESULT that
 * stands in for the application from being treated as the application.
 */
export function assertNotSeeded(context: string, value: unknown): void {
  const claims = provenanceClaims(value);
  const bad = claims.find((c) => c !== LIVE_SOURCE);
  if (bad !== undefined) {
    throw new SeededEvidenceError(
      context,
      bad === SEEDED_SOURCE
        ? "it is labelled 'demo-seed' — placeholder data produced because the app runner was not live, not a response from the app."
        : `it claims the provenance '${bad}', and only '${LIVE_SOURCE}' — a response from the real running application — counts as evidence.`,
    );
  }
  // Backstop for a value that carries the seed NOTE text but dropped its `source` field.
  if (isSeededEvidence(value)) {
    throw new SeededEvidenceError(context, 'it carries the demo-seed note, so it is placeholder data, not a response from the app.');
  }
}
