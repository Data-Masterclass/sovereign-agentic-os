/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { System, SafetyPreset, Schedule, ArtifactGrant } from '../system-schema.ts';
import { instructionsOf } from '../agent-md.ts';
import type { Check } from './run-checks.ts';
import type { DiagRun } from './run-diagnostics.ts';
import type { JudgeResult, JudgeDimension } from '../evaluate-judge.ts';

/**
 * Pure, framework-free assembly of the Evaluate PDF report — the SAME data the
 * Evaluate screen shows, structured section-by-section so the painter walks it in a
 * fixed, honest order (and so the section STRUCTURE is unit-testable without jsPDF).
 *
 * Order (and NOTHING else) mandated by the feature:
 *   0. (painter) the visual system graph — page 1.
 *   1. Main body — exactly the Evaluate content on screen: the deterministic Checks
 *      + the AI-judge scores.
 *   2. Appendix 1 — Results: the run's final output + per-agent outputs.
 *   3. Appendix 2 — Define-stage settings: purpose, safety preset, trigger mode, grants.
 *   4. Appendix 3 — Agent descriptions: each agent's name/role + instructions.
 */

const DIMENSION_LABEL: Record<JudgeDimension, string> = {
  clarity: 'Clarity',
  grounding: 'Grounding',
  actionability: 'Actionability',
};

const PRESET_LABEL: Record<SafetyPreset, string> = {
  'read-only': 'Read-only',
  'read-propose': 'Read + propose',
  'read-bounded': 'Read + bounded writes',
  'full-in-scope': 'Full in-scope',
};

const CAPABILITY_LABEL: Record<string, string> = {
  Read: 'Read',
  'Write-approval': 'Read + propose',
  'Write-bounded': 'Read + write',
  Off: 'Off',
  Blocked: 'Blocked',
};

/** The display name for an agent — its role (its Name) when set, else its id. */
export function agentDisplayName(agent: { id: string; role?: string }): string {
  return agent.role?.trim() || agent.id;
}

/** Human trigger word for a schedule (matches the Define trigger cards). */
function triggerLabel(schedule?: Schedule): string {
  const kind = schedule?.kind ?? 'manual';
  if (kind === 'cron') return `On schedule${schedule?.cron ? ` (${schedule.cron})` : ''}`;
  if (kind === 'event') return 'Called from system / API';
  return 'Manual';
}

/** A short "<name> [layer] — <access>" line for one grant, folder or item. */
function grantLine(g: ArtifactGrant): string {
  const who = g.folder ? `📁 ${g.folder.path === '/' ? 'All' : g.folder.path} (${g.folder.scope === 'domain' ? 'Domain' : 'My'})` : g.id;
  const access = CAPABILITY_LABEL[g.capability] ?? g.capability;
  const layer = g.layer ? ` · ${g.layer}` : '';
  return `${who}${layer} — ${access}`;
}

export type EvalCheckRow = { label: string; pass: boolean; detail: string };
export type EvalJudgeRow = { dimension: string; score: number; why: string };
export type EvalAgentOutput = { name: string; decision: string; model?: string; tier?: string; calls: number; output: string };
export type EvalGrantGroup = { kind: string; lines: string[] };
export type EvalAgentDescription = { name: string; role: string; instructions: string };

export type EvalReport = {
  title: string;
  ranBy: string;
  timestamp: string;
  /** MAIN BODY — the on-screen Evaluate content. */
  checks: { rows: EvalCheckRow[]; allPass: boolean };
  judge: { overall: number; rows: EvalJudgeRow[] } | null;
  /** APPENDIX 1 — Results. */
  results: { path: string; finalOutput: string; agents: EvalAgentOutput[] };
  /** APPENDIX 2 — Define-stage settings. */
  define: {
    name: string;
    purpose: string;
    safety: string;
    trigger: string;
    grants: EvalGrantGroup[];
  };
  /** APPENDIX 3 — Agent descriptions. */
  agentDescriptions: EvalAgentDescription[];
};

/**
 * Assemble the structured Evaluate report from the SAME inputs the screen renders
 * from. `judge` is null when the AI judge was not run — the section is then omitted,
 * so the PDF reflects only what is actually on screen.
 */
export function buildEvalReport(
  system: System,
  run: DiagRun,
  checks: Check[],
  judge: JudgeResult | null,
  meta: { ranBy: string; at: number },
): EvalReport {
  const g = system.grants;
  const grantGroups: EvalGrantGroup[] = [
    { kind: 'Data', arr: g.data },
    { kind: 'Knowledge', arr: g.knowledge },
    { kind: 'Files', arr: g.files },
    { kind: 'Connections', arr: g.connections },
    { kind: 'Metrics', arr: g.metrics },
    { kind: 'Plan items', arr: g.plan },
  ]
    .filter((x) => x.arr.length > 0)
    .map((x) => ({ kind: x.kind, lines: x.arr.map(grantLine) }));

  const agentOutputs: EvalAgentOutput[] = (run.nodes ?? []).map((n) => {
    const spec = system.agents.find((a) => a.id === n.node);
    return {
      name: spec ? agentDisplayName(spec) : n.node,
      decision: n.status,
      model: n.model,
      tier: n.tier,
      calls: n.steps.length,
      output: (n.finalText ?? '').trim() || '(no output)',
    };
  });

  return {
    title: system.system.name || 'Agent team',
    ranBy: meta.ranBy || 'unknown',
    timestamp: new Date(meta.at).toISOString(),
    checks: {
      rows: checks.map((c) => ({ label: c.label, pass: c.pass, detail: c.detail })),
      allPass: checks.every((c) => c.pass),
    },
    judge: judge
      ? {
          overall: judge.overall,
          rows: judge.scores.map((s) => ({
            dimension: DIMENSION_LABEL[s.dimension] ?? s.dimension,
            score: s.score,
            why: s.why,
          })),
        }
      : null,
    results: {
      path: run.path.length ? `${run.path.join(' → ')} → END` : '(no path)',
      finalOutput: (run.output ?? '').trim() || '(the run produced no final text)',
      agents: agentOutputs,
    },
    define: {
      name: system.system.name || 'Untitled team',
      purpose: (system.system.description ?? '').trim() || '(no purpose described)',
      safety: PRESET_LABEL[system.safetyPreset] ?? system.safetyPreset,
      trigger: triggerLabel(system.schedule),
      grants: grantGroups,
    },
    agentDescriptions: system.agents.map((a) => ({
      name: agentDisplayName(a),
      role: a.role?.trim() || '(no role)',
      instructions: instructionsOf(a.agent_md).trim() || '(no instructions)',
    })),
  };
}
