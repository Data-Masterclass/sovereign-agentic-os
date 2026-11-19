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
 * exists.
 *
 * `completed(ctx)` is what each stage's ✓ MEANS, and it is read from the SAVED system and its
 * last build / run — so the rail is the same on first open, after a reload, after jumping
 * between stages and for a colleague (see the contract in core/kernel/stages.ts):
 *
 *   Define    the team has a name AND a described deliverable
 *   Grant     at least one enabled context grant (an item or a folder, of any kind) that is
 *             not a folder known to be empty. If EVERY grant is an empty folder the step
 *             shows an amber "!" saying so; one empty folder next to working grants is fine
 *             (a folder grant deliberately covers items added later).
 *   Design    ≥1 agent and a start agent
 *   Build     the last build is green (and the team is still runnable)
 *   Run       the last run produced a result and did not fail or get interrupted
 *   Evaluate  that run's deterministic checks all pass
 *
 * Grant is NOT an entry gate for anything: a team that deliberately needs no context is
 * allowed, its Grant step simply stays un-ticked ("nothing granted yet").
 *
 * KNOWN LIMIT — no staleness signal. A build or run record does not say which definition it
 * was made from (no hash of system.yaml is stored with `lastBuild` / `lastRun`), so Build ✓
 * and Run ✓ mean "the LAST build/run was good", not "…of exactly the definition on screen".
 */

import type { StageDef } from '@core/kernel/stages';
import type { ArtifactGrant, System } from '@tabs/agents/lib/system-schema';

export type AgentStageId = 'define' | 'grant' | 'design' | 'build' | 'run' | 'evaluate';

/** The state the agent stage gates/✓-conditions read — derived from saved state each render. */
export type AgentStageCtx = {
  /** The system has a real name (not the "Untitled system" placeholder). */
  named: boolean;
  /** The deliverable is described (`system.description` is not blank). */
  hasGoal: boolean;
  /** How many ENABLED context grants the system holds (see {@link countContextGrants}). */
  grantCount: number;
  /**
   * How many of those grants are folder grants KNOWN to match no item today (see
   * `zeroMatchFolderGrants` in lib/grant-apply.ts). 0 while that is not known yet.
   */
  emptyGrantCount: number;
  /** The first of those, as a sentence — the Grant step's tooltip when nothing granted matches. */
  grantWarning?: string | null;
  /** ≥1 agent AND an entrypoint — the team can actually be built + run. */
  ready: boolean;
  /** The last build was green (Build's ✓ and Run's entry gate). */
  builtOk: boolean;
  /** There is a last build and it FAILED verification. */
  buildFailed: boolean;
  /** A run has produced output/nodes — the Evaluate entry gate (a failed run still has one). */
  hasRun: boolean;
  /** The last run ended because an agent failed. */
  runFailed: boolean;
  /** The last run was cut short by a restart and has not been re-run. */
  runInterrupted: boolean;
  /** The last run's deterministic checks all passed (Evaluate's ✓ condition). */
  checksPass: boolean;
};

/** The six grant lists the Grant stage writes (workflows share `knowledge`). */
const GRANT_FIELDS = ['data', 'knowledge', 'metrics', 'connections', 'files', 'plan'] as const;

/** An entry that really grants something: it names an item or a folder, and is not switched off. */
function isEnabledGrant(g: ArtifactGrant): boolean {
  if (g.capability === 'Off' || g.capability === 'Blocked') return false;
  return !!g.folder || !!g.id;
}

/**
 * How many enabled context grants the SAVED system holds — data, knowledge (incl. workflows),
 * metrics, connections, files and plan items; an item or a folder each count as one. A grant
 * switched `Off` / `Blocked` grants nothing and is not counted. A declared output's
 * auto-added destination folder IS counted: it is a grant the Grant stage shows as ticked,
 * and an un-ticked step next to a ticked folder is the contradiction this rule removes.
 */
export function countContextGrants(system: Pick<System, 'grants'>): number {
  let n = 0;
  for (const field of GRANT_FIELDS) n += (system.grants[field] ?? []).filter(isEnabledGrant).length;
  return n;
}

/** The slice of a persisted build / run record the stage conditions need. */
export type StageBuildRecord = { ok: boolean };
export type StageRunRecord = { nodes?: readonly unknown[]; output?: string; failed?: boolean; interrupted?: boolean };

/**
 * Derive the stage context from SAVED state only: the system definition, its last build
 * and its last run. Pure — the same inputs give the same rail for every viewer and on
 * every load, which is the whole point. `checksPass` is asked only when a run exists.
 */
export function agentStageCtx<Run extends StageRunRecord>(input: {
  system: System;
  lastBuild?: StageBuildRecord | null;
  lastRun?: Run | null;
  checksPass: (run: Run) => boolean;
  /** One sentence per enabled folder grant known to match nothing (`zeroMatchFolderGrants`). */
  emptyGrants?: readonly string[];
}): AgentStageCtx {
  const { system, lastBuild, lastRun } = input;
  const emptyGrants = input.emptyGrants ?? [];
  const name = system.system.name;
  const hasRun = !!lastRun && ((lastRun.nodes?.length ?? 0) > 0 || !!lastRun.output);
  return {
    named: !!name && name !== 'Untitled system',
    hasGoal: !!(system.system.description ?? '').trim(),
    grantCount: countContextGrants(system),
    emptyGrantCount: emptyGrants.length,
    grantWarning: emptyGrants.length === 0 ? null
      : emptyGrants.length === 1 ? emptyGrants[0]
        : `${emptyGrants[0]} (and ${emptyGrants.length - 1} more empty folder grant${emptyGrants.length === 2 ? '' : 's'})`,
    ready: system.agents.length > 0 && !!system.entrypoint,
    builtOk: !!lastBuild?.ok,
    buildFailed: !!lastBuild && !lastBuild.ok,
    hasRun,
    runFailed: hasRun && lastRun!.failed === true,
    runInterrupted: hasRun && lastRun!.interrupted === true,
    checksPass: hasRun && input.checksPass(lastRun!),
  };
}

/**
 * The six stages. Each `completed` names the work that stage exists for (table in the file
 * header); `problem` names what is wrong when the last attempt went badly; `pending` says
 * what is still missing. Every one reads ACTUAL system state — never a timer, never which
 * buttons were pressed.
 */
export const AGENT_STAGES: StageDef<AgentStageId, AgentStageCtx>[] = [
  {
    id: 'define', title: 'Define',
    completed: (c) => c.named && c.hasGoal,
    pending: (c) => (c.named ? 'no deliverable described yet' : 'no name yet'),
  },
  {
    id: 'grant', title: 'Grant',
    enabled: (c) => c.named,
    completed: (c) => c.grantCount > c.emptyGrantCount,
    // Something is granted, but every grant is a folder with nothing in it: say so.
    problem: (c) =>
      c.grantCount > 0 && c.emptyGrantCount >= c.grantCount
        ? { tone: 'warn', label: c.grantWarning || 'nothing granted matches any item' }
        : null,
    pending: () => 'nothing granted yet',
  },
  {
    id: 'design', title: 'Design',
    completed: (c) => c.ready,
    pending: () => 'no agent with a start point yet',
  },
  {
    id: 'build', title: 'Build',
    enabled: (c) => c.ready,
    completed: (c) => c.ready && c.builtOk,
    problem: (c) => (c.buildFailed ? { tone: 'error', label: 'the last build failed' } : null),
    pending: () => 'not built yet',
  },
  {
    id: 'run', title: 'Run',
    enabled: (c) => c.ready && c.builtOk,
    completed: (c) => c.ready && c.hasRun && !c.runFailed && !c.runInterrupted,
    problem: (c) =>
      c.runFailed ? { tone: 'error', label: 'the last run failed' }
        : c.runInterrupted ? { tone: 'warn', label: 'the last run was interrupted' }
          : null,
    pending: () => 'not run yet',
  },
  {
    id: 'evaluate', title: 'Evaluate',
    enabled: (c) => c.ready && c.hasRun,
    completed: (c) => c.ready && c.checksPass,
    problem: (c) => (c.hasRun && !c.checksPass ? { tone: 'warn', label: 'the last run did not pass every check' } : null),
    pending: () => 'no run to evaluate yet',
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
