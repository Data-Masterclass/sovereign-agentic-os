/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * The AGENTS guided path as a shared-core staged model — Define · Grant · Design ·
 * Build · Run · Evaluate. Pure and framework-free (mirrors the Software `SW_STAGES`
 * array) so the gating and ✓ rules are unit-testable on their own; the React skin is
 * components/agents/SimpleBuilder.tsx, riding components/core/StageShell.tsx.
 *
 * This is a SIX-stage flow: the previously-merged "Build & Run" is split back into a
 * dedicated Build (compile + verify) and Run (run + live progress + results + per-node
 * drill-down) stage, so each stage does one job. The trigger mode lives in Define now
 * (it's part of defining the team), not next to Run.
 *
 * INTERNAL STAGE IDS ARE KEPT STABLE where load-bearing (the OS scope-vocabulary pattern):
 *   `define` / `grant` / `design` / `build` / `evaluate` ids are UNCHANGED. The `run` id is
 *   RESTORED between build and evaluate. Any inbound legacy string still resolves via
 *   {@link aliasStageId} so a saved session position, a deep-link or an assistant `stage`
 *   verb never lands on a dead id.
 *
 * `enabled(ctx)` gates which stages are reachable off REAL system state — Grant opens once
 * the team is named, Design is always reachable, Build is gated on a runnable team (≥1 agent
 * AND an entrypoint), Run is gated on a green build, and Evaluate is blocked until a run
 * exists. `completed(ctx)` is each stage's LIVE condition; a stage shows a ✓ only when the
 * user ALSO worked it this session (tracked by the StageState in the component) — so a
 * freshly-opened system shows no pre-marked checks.
 */

import type { StageDef } from '@core/kernel/stages';

export type AgentStageId = 'define' | 'grant' | 'design' | 'build' | 'run' | 'evaluate';

/** The live state the agent stage gates/✓-conditions read — derived fresh each render. */
export type AgentStageCtx = {
  /** The system has a real name (not the "Untitled system" placeholder). */
  named: boolean;
  /** ≥1 agent AND an entrypoint — the team can actually be built + run. */
  ready: boolean;
  /** The last build was green (Build's ✓ and Run's entry gate). */
  builtOk: boolean;
  /** A run has produced output/nodes — Run's ✓ and the Evaluate entry gate. */
  hasRun: boolean;
  /** The last run's deterministic checks all passed (Evaluate's ✓ condition). */
  checksPass: boolean;
};

/**
 * The six stages. Define captures the goal + outputs + trigger (always reachable — the
 * front door). Grant opens once the system is named and hosts the safety preset + the
 * Choose-Context grant surface. Design is always reachable (the team canvas + auto-suggest).
 * Build is gated on a runnable team and is ✓ once it built green. Run is gated on a green
 * build and is ✓ once it has produced a run. Evaluate is blocked until a run exists, and is
 * ✓ once that run's deterministic checks all pass. Each gate reads ACTUAL system state
 * (`name`, agents/entrypoint, last build/run) — never a timer, never faked.
 */
export const AGENT_STAGES: StageDef<AgentStageId, AgentStageCtx>[] = [
  { id: 'define', title: 'Define', completed: (c) => c.named },
  { id: 'grant', title: 'Grant', enabled: (c) => c.named, completed: (c) => c.named },
  { id: 'design', title: 'Design', completed: (c) => c.ready },
  {
    id: 'build', title: 'Build',
    enabled: (c) => c.ready,
    completed: (c) => c.builtOk,
  },
  {
    id: 'run', title: 'Run',
    enabled: (c) => c.ready && c.builtOk,
    completed: (c) => c.hasRun,
  },
  {
    id: 'evaluate', title: 'Evaluate',
    enabled: (c) => c.ready && c.hasRun,
    completed: (c) => c.checksPass,
  },
];

/**
 * Alias a possibly-legacy stage id onto the live path. Every current id passes through;
 * the old merged `build-run` id (from the five-stage era) folds onto `build`. An unknown
 * string falls back to `define` so a bad deep-link opens the front door rather than a
 * blank stage. Keeps saved sessions, deep-links and assistant stage verbs alive.
 */
export function aliasStageId(id: string): AgentStageId {
  if (id === 'build-run') return 'build';
  return (AGENT_STAGES.some((s) => s.id === id) ? id : 'define') as AgentStageId;
}
