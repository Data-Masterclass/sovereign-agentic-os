/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    Software Factory - the quality-gate report and the verdict computed from it
 * USER STORY: As a builder approving a deploy I want one rule for "the gates passed": every required
 *             gate ran and passed, on the tree that ships - and I never want a script's own
 *             "ok: true" to be taken on trust.
 * ARCHITECTURE:
 *   - The verdict is built by the OS from a channel the app cannot write: the exit code of each gate's own
 *     sandbox step, as recorded by the kubelet in the pod status ({@link reportFromGateExits}). Text the app
 *     prints is display only and never decides anything: there is no log parser here on purpose.
 *     {@link evaluateGates} then treats `unavailable` and a MISSING required gate as blocking, and turns a
 *     sandbox that could not run into a block carrying its reason.
 *   - The same `scripts/factory-gates.mjs` runs on a laptop for the author; in the sandbox it is the
 *     PLATFORM's copy (overlaid), run once per gate.
 *   - Vulnerability scanning is a separate required gate run by the OS scanner (scan.ts, Trivy); it is
 *     not repeated here.
 *   - PURE: no I/O, no `server-only`.
 */

/** Frames the laptop report printed by scripts/factory-gates.mjs. The OS never reads it for a verdict. */
export const GATES_REPORT_DELIM = '<<<OS-GATES-REPORT>>>';

/** The gates the sandbox must report. Order is the order a human reads them in. */
export const REQUIRED_GATES = ['typecheck', 'lint', 'tests', 'build', 'policy'] as const;

export type GateStatus = 'pass' | 'fail' | 'unavailable';
export type GateResult = { id: string; status: GateStatus; detail: string; violations?: string[] };
export type GatesReport = { schema: 'os-gates/v1'; template: string; ok: boolean; gates: GateResult[] };

export type SandboxFailure = { ok: false; kind: 'no-cluster' | 'sandbox-failed' | 'disabled' | 'superseded'; reason: string };
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
  // The required gates, then any other gate the report carries (e.g. `install`): a non-pass there blocks too.
  const ids = [...REQUIRED_GATES, ...outcome.report.gates.map((g) => g.id).filter((id) => !(REQUIRED_GATES as readonly string[]).includes(id))];
  for (const id of ids) {
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

/** Exit code the gates script uses for "this gate could not run" (OPA unreachable, ...): not a pass. */
export const EXIT_UNAVAILABLE = 3;

export type GateExit = {
  id: string;
  /** The step's exit code from the pod status; null = the step never ran to completion. */
  exitCode: number | null;
  /** Why it has no exit code (waiting/running/terminated reason), for the message. */
  note?: string;
  /** Display-only tail of the step's output, only ever read for a gate that did not pass. */
  tail?: string;
};

/** Build the report from per-gate exit codes. 0 = pass, 3 = unavailable, no exit code = unavailable, anything else = fail. */
export function reportFromGateExits(template: string, exits: GateExit[], extra: GateResult[] = []): GatesReport {
  const gates: GateResult[] = [
    ...extra,
    ...exits.map((e): GateResult => {
      if (e.exitCode === 0) return { id: e.id, status: 'pass', detail: `${e.id} step exited 0` };
      if (e.exitCode === null) return { id: e.id, status: 'unavailable', detail: `${e.id} step did not complete${e.note ? ` (${e.note})` : ''}` };
      if (e.exitCode === EXIT_UNAVAILABLE) return { id: e.id, status: 'unavailable', detail: `${e.id} could not run${e.tail ? `: ${e.tail}` : ''}` };
      return { id: e.id, status: 'fail', detail: `${e.id} step exited ${e.exitCode}${e.tail ? `:\n${e.tail}` : ''}` };
    }),
  ];
  return { schema: 'os-gates/v1', template, ok: gates.every((g) => g.status === 'pass'), gates };
}
