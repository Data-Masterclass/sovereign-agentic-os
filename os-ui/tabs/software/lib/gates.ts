/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    Software Factory - the quality-gate report and the verdict computed from it
 * USER STORY: As a builder approving a deploy I want one rule for "the gates passed": every required
 *             gate ran and passed, on the tree that ships - and I never want a script's own
 *             "ok: true" to be taken on trust.
 * ARCHITECTURE:
 *   - The report is produced by the app's own `scripts/factory-gates.mjs` (so an author can run the same
 *     gates on a laptop). The OS never trusts its `ok` field: {@link evaluateGates} recomputes the
 *     verdict from the individual gates, treats `unavailable` and a MISSING required gate as blocking,
 *     and turns a sandbox that could not run into a block carrying its reason.
 *   - Vulnerability scanning is a separate required gate run by the OS scanner (scan.ts, Trivy); it is
 *     not repeated here.
 *   - PURE: no I/O, no `server-only`.
 */

export const GATES_REPORT_DELIM = '<<<OS-GATES-REPORT>>>';

/** The gates the sandbox must report. Order is the order a human reads them in. */
export const REQUIRED_GATES = ['typecheck', 'lint', 'tests', 'policy'] as const;

export type GateStatus = 'pass' | 'fail' | 'unavailable';
export type GateResult = { id: string; status: GateStatus; detail: string; violations?: string[] };
export type GatesReport = { schema: 'os-gates/v1'; template: string; ok: boolean; gates: GateResult[] };

export type SandboxFailure = { ok: false; kind: 'no-cluster' | 'sandbox-failed' | 'disabled'; reason: string };
export type GatesOutcome = { ok: true; report: GatesReport } | SandboxFailure;

export type GateVerdict = {
  passed: boolean;
  blocking: { id: string; detail: string }[];
  /** One sentence for a refusal message or a card. */
  summary: string;
};

export function evaluateGates(outcome: GatesOutcome): GateVerdict {
  if (!outcome.ok) {
    const detail = `The quality gates could not run (${outcome.kind}): ${outcome.reason}`;
    return { passed: false, blocking: [{ id: 'sandbox', detail }], summary: detail };
  }
  const byId = new Map(outcome.report.gates.map((g) => [g.id, g]));
  const blocking: { id: string; detail: string }[] = [];
  for (const id of REQUIRED_GATES) {
    const g = byId.get(id);
    if (!g) blocking.push({ id, detail: `gate '${id}' did not run: the report does not contain it` });
    else if (g.status === 'unavailable') blocking.push({ id, detail: `gate '${id}' is unavailable, which is not a pass: ${g.detail}` });
    else if (g.status !== 'pass') {
      const v = g.violations?.length ? ` ${g.violations.slice(0, 5).join('; ')}` : '';
      blocking.push({ id, detail: `gate '${id}' failed: ${g.detail}${v}`.slice(0, 1500) });
    }
  }
  const passed = blocking.length === 0;
  return {
    passed,
    blocking,
    summary: passed ? 'All quality gates passed.' : `Quality gates blocked this deploy: ${blocking.map((b) => b.id).join(', ')}. ${blocking[0].detail}`,
  };
}

/** Read the report from a pod log: only the framed section is believed; everything before it is noise. */
export function parseGatesLog(text: string): GatesOutcome {
  const at = text.lastIndexOf(GATES_REPORT_DELIM);
  if (at < 0) return { ok: false, kind: 'sandbox-failed', reason: 'the sandbox log carries no gates report, so no gate ran to completion' };
  try {
    const report = JSON.parse(text.slice(at + GATES_REPORT_DELIM.length).trim()) as GatesReport;
    if (report?.schema !== 'os-gates/v1' || !Array.isArray(report.gates)) throw new Error('unexpected shape');
    return { ok: true, report };
  } catch (e) {
    return { ok: false, kind: 'sandbox-failed', reason: `the gates report could not be read (${e instanceof Error ? e.message : String(e)})` };
  }
}
