/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    Software Factory - the check result recorded against a commit sha
 * USER STORY: As a builder I want every check result stored against the exact commit it ran on, with a
 *             status per check, its log and the time, so the app shows what is true of the head and a
 *             deploy takes only a commit that is all green.
 * ARCHITECTURE:
 *   - ENGINE-NEUTRAL SHAPE. A record says WHAT was checked (`sha`), WHAT happened (`checks`), WHEN, and
 *     which engine produced it (`engine` + an opaque `runRef`). The sandbox Job fills it today; another
 *     engine (a Tekton PipelineRun) can fill the same shape without touching a reader.
 *   - The verdict is RECOMPUTED from the per-check statuses (`recordVerdict`); a record's own claim is
 *     never read. A required check that is missing, `unavailable`, or from a run that is not finished
 *     blocks. A record for another sha never answers for this one.
 *   - PURE: no I/O. The records live on the app (`App.checks`), newest first, bounded.
 */
import { REQUIRED_GATES, evaluateGates, type GatesOutcome } from '@tabs/software/lib/gates';

export type CheckStatus = 'pass' | 'fail' | 'unavailable';
export type CheckEntry = { id: string; status: CheckStatus; detail: string; violations?: string[]; log?: string };
export type CheckRunStatus = 'running' | 'finished' | 'superseded';
export type CheckTrigger = 'push' | 'button' | 'mcp' | 'deploy';

export type CheckRecord = {
  sha: string;
  status: CheckRunStatus;
  trigger: CheckTrigger;
  /** Which engine produced this record, e.g. `sandbox-job`. */
  engine: string;
  /** Opaque handle of the run in that engine (Job name, PipelineRun name). */
  runRef: string | null;
  startedAt: string;
  finishedAt: string | null;
  checks: CheckEntry[];
  /** Set when no check could run at all (no cluster, sandbox failed): the reason, in a sentence. */
  error: string | null;
};

export const MAX_CHECK_RECORDS = 20;
const LOG_CAP = 4000;

/** Turn one sandbox outcome (plus the OS's own scan result, if any) into a finished record. */
export function recordFromOutcome(input: {
  sha: string;
  trigger: CheckTrigger;
  engine: string;
  runRef?: string | null;
  startedAt: string;
  finishedAt: string;
  outcome: GatesOutcome;
  extra?: CheckEntry[];
}): CheckRecord {
  const { outcome } = input;
  const checks: CheckEntry[] = outcome.ok
    ? outcome.report.gates.map((g) => ({ id: g.id, status: g.status, detail: g.detail.slice(0, LOG_CAP), ...(g.violations ? { violations: g.violations.slice(0, 50) } : {}) }))
    : [];
  return {
    sha: input.sha,
    status: 'finished',
    trigger: input.trigger,
    engine: input.engine,
    runRef: input.runRef ?? null,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    checks: [...checks, ...(input.extra ?? [])],
    error: outcome.ok ? null : `${outcome.kind}: ${outcome.reason}`,
  };
}

export type RecordVerdict = { green: boolean; reason: string };

/** Is this record, for THIS sha, all green? Required = the sandbox gates (the scan joins via `extra`). */
export function recordVerdict(rec: CheckRecord | null | undefined, sha: string): RecordVerdict {
  if (!rec) return { green: false, reason: `no check result is recorded for ${sha.slice(0, 12)}` };
  if (rec.sha !== sha) return { green: false, reason: `the recorded result is for ${rec.sha.slice(0, 12)}, not ${sha.slice(0, 12)}` };
  if (rec.status !== 'finished') return { green: false, reason: `the checks for ${sha.slice(0, 12)} are ${rec.status}, not finished` };
  if (rec.error) return { green: false, reason: `the checks could not run: ${rec.error}` };
  const v = evaluateGates({ ok: true, report: { schema: 'os-gates/v1', template: 'recorded', ok: false, gates: rec.checks.filter((c) => (REQUIRED_GATES as readonly string[]).includes(c.id)) } });
  if (!v.passed) return { green: false, reason: v.summary };
  const bad = rec.checks.find((c) => c.status !== 'pass');
  if (bad) return { green: false, reason: `check '${bad.id}' is ${bad.status}: ${bad.detail.slice(0, 300)}` };
  return { green: true, reason: 'all checks passed' };
}

/** The newest record for exactly this sha (a superseded one is returned too; the verdict refuses it). */
export function recordFor(records: CheckRecord[] | undefined, sha: string): CheckRecord | null {
  return (records ?? []).find((r) => r.sha === sha) ?? null;
}

/** Store `rec` newest-first, replacing an earlier record for the same sha. Returns a new array. */
export function upsertRecord(records: CheckRecord[] | undefined, rec: CheckRecord): CheckRecord[] {
  return [rec, ...(records ?? []).filter((r) => r.sha !== rec.sha)].slice(0, MAX_CHECK_RECORDS);
}
