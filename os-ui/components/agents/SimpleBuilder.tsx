/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import BuildRunPanel from './BuildRunPanel';
import RecurrenceEditor from './RecurrenceEditor';
import GrantStage from './GrantStage';
import AgentStageAssistant from './AgentStageAssistant';
import { NewFolderField } from './GrantPickers';
import type { System, OutputKind } from '@/lib/agents/system-schema';
import { classifyModelNeed } from '@/lib/agents/routing';
import { instructionsOf } from '@/lib/agents/agent-md';
import {
  addSimpleAgent, moveAgent, removeAgentSimple,
  setAgentInstructions, setAgentRole,
  setDescription, addSystemTool,
  addOutput, removeOutput,
} from '@/lib/agents/simple-edit';
import { useToast } from '@/components/core/Toast';
import { normaliseFolderPath } from '@/lib/core/folders';
import { scopeLabel } from '@/lib/core/scopes';
import {
  capabilityChipsForGrants, toolsForCapabilityChipsInPool, chipIdsForTools,
  type CapabilityChip,
} from '@/lib/agents/capability-tools';
import { setEntrypoint } from '@/lib/agents/canvas-edit';
import { canSaveFromResult, DATA_NON_TABULAR_NOTE } from '@/lib/agents/output-save';
import { AGENT_TEMPLATES, agentTemplate, type AgentTemplateKey } from '@/lib/agents/agent-templates';
import StageShell from '@/components/core/StageShell';
import { usePublishPageContext } from '@/components/core/PageContext';
import {
  advance, goTo, initialStageState, isSatisfied, markDone,
  type StageState,
} from '@/lib/core/stages';
import { AGENT_STAGES, type AgentStageId, type AgentStageCtx } from '@/lib/agents/stages';
import { runChecks, allChecksPass } from '@/lib/agents/build/run-checks';
import type { DiagRun } from '@/lib/agents/build/run-diagnostics';
import { dimensionLabel, type JudgeResult } from '@/lib/agents/evaluate-judge';
import { downloadEvalPdf } from '@/lib/agents/build/agent-pdf';
import { useUser } from '@/lib/useUser';

/**
 * Simple mode — the guided builder for non-coders, a SIX-stage path:
 *   Define · Grant · Design · Build · Run · Evaluate.
 * It reads and writes the SAME `system.yaml` / `agents/<id>/AGENT.md` Developer mode
 * does, through the SAME `commitSystem` file write and `/api/agents` endpoints. There
 * is NO parallel data model. Build/Run/Evaluate reuse the ONE `BuildRunPanel` run engine
 * (gated per phase); the schedule reuses the existing schedule route; the LLM-judge reuses
 * the ONE governed assistant model via the evaluate route.
 *
 *  1. Define    — Name + a plain "Describe the deliverable" box + where the results go + trigger.
 *  2. Grant     — the safety preset + the Choose-Context grant surface (shared shell).
 *  3. Design    — the team: per-agent cards, a template picker, and an auto-suggested team.
 *  4. Build     — compile + verify (the same build developers run).
 *  5. Run       — one-click ▶ Run, live progress, the final result + per-node drill-down.
 *  6. Evaluate  — per-agent breakdown + deterministic checks + LLM-judge + diagnostics/PDF/trace.
 *
 * The stage rail + gating ride the OS-wide staged-builder primitive (lib/agents/stages.ts +
 * lib/core/stages.ts + components/core/StageShell.tsx). Every stage body mounts a per-stage
 * assistant (AgentStageAssistant) at the TOP, which auto-suggests on entry. The stage CONTENT
 * below stays Agents-specific.
 *
 * This is the EDIT surface. A ready-and-tested system (built + run at least once) opens in a
 * read-only VIEW instead (see ReadOnlyView) with a ✎ Edit affordance owned by SystemView.
 */

const PHASES = AGENT_STAGES;

type BuildRunProps = {
  running: boolean;
  lastBuild: React.ComponentProps<typeof BuildRunPanel>['lastBuild'];
  activity: React.ComponentProps<typeof BuildRunPanel>['activity'];
  lastRun: React.ComponentProps<typeof BuildRunPanel>['lastRun'];
  nodePath: string[];
  /** True for editors AND in-domain consumers who may run a Shared system. Optional
   *  (falls back to canEdit in the panel) — threaded so read-only VIEW can still Run. */
  canRun?: boolean;
};

export default function SimpleBuilder({
  systemId,
  system,
  canEdit,
  catalog,
  buildRun,
  onCommit,
  onReload,
  view = false,
  onEdit,
}: {
  systemId: string;
  system: System;
  canEdit: boolean;
  /** Tool names the user may grant (role-scoped catalog); null while loading. */
  catalog: string[] | null;
  buildRun: BuildRunProps;
  /** Commit a mutated System through the shared path (SystemView owns undo/redo). */
  onCommit: (next: System) => Promise<void> | void;
  /** Re-fetch the system view after a server-side edit (scaffold). */
  onReload: () => Promise<void> | void;
  /**
   * Read-only VIEW mode — a ready-and-tested system (built + run at least once) opens here
   * instead of the six-stage EDIT builder: Trigger/Run · Monitor · Results + Diagnostics,
   * reusing the same Run + Evaluate panels arranged read-only. SystemView owns the gate +
   * the ✎ Edit toggle (`onEdit`). Absent/false = the EDIT builder.
   */
  view?: boolean;
  onEdit?: () => void;
}) {
  // Read-only VIEW — the calm surface for a finished team: run it now (or see its schedule),
  // watch it run, read the last result + diagnostics. Reuses the Run + Evaluate panels.
  if (view) {
    return (
      <ReadOnlyView
        systemId={systemId}
        system={system}
        canEdit={canEdit}
        buildRun={buildRun}
        onReload={onReload}
        onEdit={onEdit}
      />
    );
  }
  // Always OPEN on Define — creating a new system OR opening an existing one lands
  // here, never jumping ahead. Phase checkmarks reflect what the user has actually
  // completed THIS session (`stage.done`), so a freshly opened system shows NO green
  // checks even if its persisted state happens to satisfy a phase's condition. Both
  // rules are guaranteed by the shared stage model (lib/core/stages.ts).
  const [stage, setStage] = useState<StageState<AgentStageId>>(() => initialStageState(PHASES));
  const phase = stage.current;

  // Tell "Ask the OS" exactly what's open: this agent system + the current phase, so
  // the assistant acts on THIS agent without asking which one. Clears on unmount.
  usePublishPageContext({
    tab: 'agents',
    stage: phase,
    artifactType: 'agent',
    artifactId: systemId,
    artifactName: system.system.name,
  });

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const editable = canEdit && !busy;
  const hasAgents = system.agents.length > 0;
  const ready = hasAgents && !!system.entrypoint;
  const hasRun = !!buildRun.lastRun && ((buildRun.lastRun.nodes?.length ?? 0) > 0 || !!buildRun.lastRun.output);

  const guard = useCallback(
    async (fn: () => Promise<void> | void) => {
      if (busy) return;
      setBusy(true);
      setErr('');
      try { await fn(); }
      catch (e) { setErr((e as Error).message); }
      finally { setBusy(false); }
    },
    [busy],
  );

  const commit = useCallback((next: System) => guard(() => onCommit(next)), [guard, onCommit]);

  // The live context the PHASES gates/conditions read. `checksPass` inspects the run
  // only when one exists (&& short-circuit), matching the old lazy evaluate condition.
  const ctx: AgentStageCtx = {
    named: !!system.system.name && system.system.name !== 'Untitled system',
    ready,
    builtOk: !!buildRun.lastBuild?.ok,
    hasRun,
    checksPass: hasRun && allChecksPass(runChecks(lastRunToDiag(buildRun.lastRun!))),
  };

  // Every transition goes through the shared stage model: `go` jumps (entry-gated),
  // `next` advances and records the current phase's ✓ only when its condition is met
  // — the same "mark if done, then move" behavior the builder always had.
  const go = (id: AgentStageId) => setStage((s) => goTo(PHASES, s, id, ctx));
  const next = () => setStage((s) => advance(PHASES, s, ctx));

  // Build · Run · Evaluate complete inside their own panels (no explicit "Next"), so
  // once the user is ON one of those phases and its live condition is met, record it
  // as completed. Gated on the current phase so nothing is pre-marked before the user
  // has actually worked that step.
  useEffect(() => {
    if ((phase === 'build' || phase === 'run' || phase === 'evaluate') && isSatisfied(PHASES, phase, ctx)) {
      setStage((s) => markDone(s, phase));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, buildRun.lastBuild?.ok, hasRun, buildRun.lastRun]);

  // The per-stage assistant, mounted at the TOP of every stage body. One helper, one
  // endpoint; it auto-suggests on entering each stage (edit-mode only — read-only VIEW
  // never fires it, since nothing can be applied there).
  //
  // Define is ASK-FIRST: with no deliverable yet there is nothing to ground a suggestion in,
  // so we do NOT auto-fire — the assistant's intro/starters invite the user to say what they
  // want, and it only proactively refines once a description exists. Every other stage keeps
  // its on-entry suggestion (Grant/Design/Evaluate ground in the description + grants already
  // captured; Build/Run are plain explanations).
  const hasDeliverable = !!(system.system.description ?? '').trim();
  const assistantAutoSuggest = editable && (phase !== 'define' || hasDeliverable);
  const assistant = (
    <AgentStageAssistant systemId={systemId} system={system} stage={phase} canEdit={editable} onCommit={commit} autoSuggest={assistantAutoSuggest} />
  );

  return (
    <div className="simple-builder">
      {/* The shared staged-builder chrome: the numbered `.sb-step*` rail with gated
          jumps + session ✓s. Headers/footers stay bespoke per phase (below), so the
          shell renders rail-only. */}
      <StageShell
        stages={PHASES}
        state={stage}
        ctx={ctx}
        onState={setStage}
        ariaLabel="Build phases"
        showHeader={false}
        showNav={false}
        aside={
          // Runtime badge — read-only, tells the author which engine runs their team.
          hasAgents ? (
            <span className="badge" title={`This team runs on the ${system.runtime} runtime`}>
              {system.runtime === 'hermes' ? 'Autonomous (Hermes)' : 'Graph (LangGraph)'}
            </span>
          ) : null
        }
      >

      {err ? <div className="error" style={{ marginBottom: 12 }}>{err}</div> : null}

      {phase === 'define' ? (
        <div>
          {assistant}
          <DefineStep
            systemId={systemId}
            system={system}
            canEdit={editable}
            onCommit={(next) => commit(next)}
            onReload={onReload}
            onNext={next}
          />
        </div>
      ) : null}

      {phase === 'grant' ? (
        <div>
          {assistant}
          <GrantStage systemId={systemId} system={system} canEdit={editable} onCommit={commit} />
          <div className="row" style={{ justifyContent: 'space-between', marginTop: 18 }}>
            <button className="btn ghost sm" onClick={() => go('define')}>← Define</button>
            <button className="btn" onClick={() => go('design')}>Design your team →</button>
          </div>
        </div>
      ) : null}

      {phase === 'design' ? (
        <div>
          {assistant}
          <DesignStep
            systemId={systemId}
            system={system}
            canEdit={editable}
            catalog={catalog}
            onCommit={commit}
            onReload={onReload}
            onBack={() => go('grant')}
            onNext={next}
            ready={ready}
          />
        </div>
      ) : null}

      {phase === 'build' ? (
        <div className="sb-run">
          {assistant}
          <h2 className="sb-section-title" style={{ marginTop: 0 }}>Build</h2>
          <p className="hint" style={{ marginTop: 0 }}>
            Compile and verify your team — the same build developers run. Each step turns ✓ only when it
            both applies and verifies, so a green build is a real one. Then move to Run.
          </p>
          <BuildRunPanel
            systemId={systemId}
            system={system}
            running={buildRun.running}
            canEdit={canEdit}
            lastBuild={buildRun.lastBuild}
            activity={buildRun.activity}
            lastRun={buildRun.lastRun}
            nodePath={buildRun.nodePath}
            onStateChange={onReload}
            phase="build"
          />
          <div className="row" style={{ justifyContent: 'space-between', marginTop: 14 }}>
            <button className="btn ghost sm" onClick={() => go('design')}>← Design</button>
            <button className="btn" onClick={next} disabled={!ctx.builtOk} title={ctx.builtOk ? 'Run the team' : 'Build the team first'}>Run →</button>
          </div>
        </div>
      ) : null}

      {phase === 'run' ? (
        <div className="sb-run">
          {assistant}
          <h2 className="sb-section-title" style={{ marginTop: 0 }}>Run</h2>
          <p className="hint" style={{ marginTop: 0 }}>
            Run it with one press: it walks from the START agent and shows its progress and final result.
            Open any agent to see what it was given, what it produced, and each tool call. The full
            step-by-step assessment lives under Evaluate.
          </p>
          <BuildRunPanel
            systemId={systemId}
            system={system}
            running={buildRun.running}
            canEdit={canEdit}
            canRun={buildRun.canRun}
            lastBuild={buildRun.lastBuild}
            activity={buildRun.activity}
            lastRun={buildRun.lastRun}
            nodePath={buildRun.nodePath}
            onStateChange={onReload}
            phase="run"
          />
          <div className="row" style={{ justifyContent: 'space-between', marginTop: 14 }}>
            <button className="btn ghost sm" onClick={() => go('build')}>← Build</button>
            <button className="btn" onClick={next} disabled={!hasRun} title={hasRun ? 'Evaluate the run' : 'Run the team first'}>Evaluate →</button>
          </div>
        </div>
      ) : null}

      {phase === 'evaluate' ? (
        <div className="sb-run">
          {assistant}
          <h2 className="sb-section-title" style={{ marginTop: 0 }}>Evaluate</h2>
          <p className="hint" style={{ marginTop: 0 }}>
            Check the run against clear, honest tests — deterministic checks first, then an optional
            AI judge — and download a report.
          </p>
          <EvaluateStep systemId={systemId} system={system} lastRun={buildRun.lastRun} canEdit={editable} />
          <BuildRunPanel
            systemId={systemId}
            system={system}
            running={buildRun.running}
            canEdit={canEdit}
            lastBuild={buildRun.lastBuild}
            activity={buildRun.activity}
            lastRun={buildRun.lastRun}
            nodePath={buildRun.nodePath}
            onStateChange={onReload}
            phase="evaluate"
          />
          <button className="btn ghost sm" style={{ marginTop: 14 }} onClick={() => go('run')}>← Back to Run</button>
        </div>
      ) : null}
      </StageShell>
    </div>
  );
}

/* ─────────────────────────── Read-only VIEW ─────────────────────────── */

/**
 * ReadOnlyView — the calm surface a ready-and-tested team opens in (built + run at least
 * once), mirroring the OS-wide View/Edit pattern (Data/Metrics/Dashboards detail views open
 * View; ✎ Edit → the builder). Nothing here mutates the team's design; it only RUNS it and
 * SHOWS the last run. Three sections, reusing the SAME panels the builder uses:
 *
 *   • Trigger / Run — how it's triggered (Manual / schedule / called-from-system) plus a
 *     prominent ▶ Run control and live "running…" state — the Run phase of BuildRunPanel.
 *   • Monitor — live progress + last-run status (carried by the same Run panel).
 *   • Results + Diagnostics — the last run's final output, per-node drill-down, and the
 *     Evaluate diagnostics (latency/tokens/cost/errors + Langfuse + PDF) — EvaluateStep +
 *     the Evaluate phase of BuildRunPanel, read-only (canEdit=false disables applies).
 *
 * The ✎ Edit affordance (owned by SystemView) opens the six-stage EDIT builder.
 */
function ReadOnlyView({
  systemId, system, canEdit, buildRun, onReload, onEdit,
}: {
  systemId: string;
  system: System;
  canEdit: boolean;
  buildRun: BuildRunProps;
  onReload: () => void | Promise<void>;
  onEdit?: () => void;
}) {
  const triggerKind = system.schedule?.kind ?? 'manual';
  const triggerWord = triggerKind === 'cron' ? 'On schedule' : triggerKind === 'event' ? 'Called from system' : 'Manual';

  return (
    <div className="simple-builder sb-view">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', gap: 12, marginBottom: 8 }}>
        <div>
          <h2 className="sb-section-title" style={{ marginTop: 0, marginBottom: 2 }}>Ready to run</h2>
          <p className="hint" style={{ marginTop: 0 }}>
            This team is built and tested. Run it now, watch it work, and review the last run’s result and diagnostics.
          </p>
        </div>
        {canEdit && onEdit ? (
          <button className="btn ghost sm" onClick={onEdit} title="Open the guided builder to change this team">✎ Edit</button>
        ) : null}
      </div>

      {/* Trigger / Run + Monitor — the Run panel: a prominent ▶ Run, live progress, results.
          For a scheduled / called-from-system team the trigger is shown; the run control
          stays available (a manual run of a scheduled team is a normal, useful action). */}
      <div className="sb-run" style={{ marginBottom: 8 }}>
        <div className="row" style={{ alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span className="badge">{triggerWord}</span>
          {triggerKind === 'cron' && system.schedule?.cron ? (
            <span className="hint" style={{ marginTop: 0 }}>Scheduled · <span className="mono">{system.schedule.cron}</span></span>
          ) : triggerKind === 'event' ? (
            <span className="hint" style={{ marginTop: 0 }}>Runs when called from another system or the API.</span>
          ) : null}
        </div>
        <BuildRunPanel
          systemId={systemId}
          system={system}
          running={buildRun.running}
          canEdit={canEdit}
          canRun={buildRun.canRun}
          lastBuild={buildRun.lastBuild}
          activity={buildRun.activity}
          lastRun={buildRun.lastRun}
          nodePath={buildRun.nodePath}
          onStateChange={onReload}
          phase="run"
        />
      </div>

      {/* Results + Diagnostics — the same Evaluate surfaces, read-only (canEdit=false).
          EvaluateStep carries the checks, AI judge and PDF; the Evaluate panel adds the
          context roll-up, per-agent diagnostics and Langfuse trace link. */}
      <div className="sb-run">
        <h2 className="sb-section-title" style={{ marginTop: 0 }}>Results &amp; diagnostics</h2>
        <EvaluateStep systemId={systemId} system={system} lastRun={buildRun.lastRun} canEdit={false} />
        <BuildRunPanel
          systemId={systemId}
          system={system}
          running={buildRun.running}
          canEdit={false}
          lastBuild={buildRun.lastBuild}
          activity={buildRun.activity}
          lastRun={buildRun.lastRun}
          nodePath={buildRun.nodePath}
          onStateChange={onReload}
          phase="evaluate"
        />
      </div>
    </div>
  );
}

/* ─────────────────────────── Stage 1 — Define ─────────────────────────── */

/**
 * Stage 1 — Define. The essentials: Name, a plain "Describe the deliverable" box (the
 * deliverable / success-criteria text that grounds the Design auto-suggest AND the Evaluate
 * judge — it NO LONGER scaffolds a team here; that moves to Design), "Where the results go"
 * (declared outputs), and HOW the team is triggered (Manual / On schedule / Called from
 * system). The safety preset + grants live in Grant. Success criteria live in the deliverable
 * prose or a granted Knowledge workflow; there is deliberately NO separate acceptance field.
 */
function DefineStep({
  systemId,
  system,
  canEdit,
  onCommit,
  onReload,
  onNext,
}: {
  systemId: string;
  system: System;
  canEdit: boolean;
  onCommit: (next: System) => void;
  onReload: () => void | Promise<void>;
  onNext: () => void;
}) {
  const [name, setName] = useState(system.system.name === 'Untitled system' ? '' : system.system.name);
  // Seed the deliverable box from the persisted description so the judge's task and the
  // Design proposer share one source of truth (re-seeded when it changes server-side).
  const [desc, setDesc] = useState(system.system.description ?? '');

  useEffect(() => { setName(system.system.name === 'Untitled system' ? '' : system.system.name); }, [system.system.name]);
  useEffect(() => { setDesc(system.system.description ?? ''); }, [system.system.description]);

  const saveName = () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === system.system.name) return;
    onCommit({ ...system, system: { ...system.system, name: trimmed } });
  };

  // Persist the deliverable text as the team's purpose (grounds the Design proposer + the
  // Evaluate judge). Skipped when unchanged so we never churn system.yaml on a no-op blur.
  const saveDesc = () => {
    if (desc.trim() === (system.system.description ?? '').trim()) return;
    onCommit(setDescription(system, desc));
  };

  return (
    <div className="sb-describe">
      {/* Name on top */}
      <div className="sb-name-row" style={{ marginTop: 0, marginBottom: 16 }}>
        <label className="sb-field-label" htmlFor="sb-name">Name your team</label>
        <input
          id="sb-name"
          type="text"
          value={name}
          disabled={!canEdit}
          onChange={(e) => setName(e.target.value)}
          onBlur={saveName}
          onKeyDown={(e) => { if (e.key === 'Enter') saveName(); }}
          placeholder="e.g. Renewals desk"
        />
      </div>

      {/* The deliverable box — plain words, no scaffold. It grounds Design + Evaluate. */}
      <div className="sb-hero">
        <h2 className="sb-hero-title">Describe the deliverable</h2>
        <p className="sb-hero-sub">
          Say, in plain words, what this team should produce and what a good result looks like.
          You’ll grant its context next, then design (or auto-propose) the team.
        </p>
        <textarea
          className="sb-hero-input"
          rows={3}
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          onBlur={saveDesc}
          disabled={!canEdit}
          placeholder="e.g. a weekly report that pulls campaign data, checks margins after returns, scores each campaign against the rules, and recommends budget changes"
        />
        <p className="hint" style={{ marginTop: 8 }}>Success criteria go here or in a granted Knowledge workflow.</p>
      </div>

      {/* Where the results go — declared outputs (auto-provisioned Write targets) */}
      <OutputsSection systemId={systemId} system={system} canEdit={canEdit} onCommit={onCommit} />

      {/* How the team is triggered — Manual / On schedule / Called from system. Part of
          DEFINING the team, so it lives here (not next to Run). Same /schedule route. */}
      <TriggerMode systemId={systemId} system={system} canEdit={canEdit} onReload={onReload} />

      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
        <button className="btn" onClick={() => { saveName(); onNext(); }} disabled={!name.trim()}>Grant context →</button>
      </div>
    </div>
  );
}

/* ─────────────────────────── Phase 2 — Design ─────────────────────────── */

/** A marketplace-sourced agent the picker can copy into the team (ungated text copy). */
type MarketplaceAgent = { role: string; instructions: string; source: string };

/**
 * Phase 2 — Design. The team: per-agent cards (unchanged) plus a template picker on
 * "+ Add agent". The picker offers the curated role templates AND agents pulled from
 * marketplace-shared systems. Adding calls `addSimpleAgent(sys,{role,instructions})`
 * then applies any suggested tools via `addAgentTool` — ordinary system.yaml edits.
 */
function DesignStep({
  systemId,
  system,
  canEdit,
  catalog,
  onCommit,
  onReload,
  onBack,
  onNext,
  ready,
}: {
  systemId: string;
  system: System;
  canEdit: boolean;
  catalog: string[] | null;
  onCommit: (next: System) => void;
  onReload: () => Promise<void> | void;
  onBack: () => void;
  onNext: () => void;
  ready: boolean;
}) {
  const [picking, setPicking] = useState(false);

  // Add a curated template: create the agent, then make sure its suggested tools exist
  // in the TEAM POOL (catalog-permitting — never a tool outside the caller's role floor).
  // A fresh agent is left with NO explicit `tools` so it INHERITS THE FULL, GROWING team
  // grant pool (matching the blank/marketplace add-paths): a dataset granted later in
  // Define reaches it automatically. We add suggested tools to the pool (not to the
  // agent) so we never freeze the agent to a snapshot that would then miss later grants;
  // the user can still narrow per agent afterwards via the capability chips. The agent's
  // ROLE is its name — prefill it with the template's name (e.g. "Analyst"), which the
  // user can overwrite in the card; the descriptive prose lives in the instructions.
  // "Blank" keeps its generic "A helpful assistant" role.
  const addTemplate = (key: AgentTemplateKey) => {
    const tpl = agentTemplate(key);
    const def = AGENT_TEMPLATES.find((t) => t.key === key);
    const roleName = key === 'blank' || !def ? tpl.role : def.label;
    let next = addSimpleAgent(system, { role: roleName, instructions: tpl.instructions });
    for (const t of tpl.suggestedTools ?? []) {
      if (!catalog || catalog.includes(t)) next = addSystemTool(next, t);
    }
    onCommit(next);
    setPicking(false);
  };

  const addMarketplace = (a: MarketplaceAgent) => {
    onCommit(addSimpleAgent(system, { role: a.role, instructions: a.instructions }));
    setPicking(false);
  };

  return (
    <div className="sb-agents">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div>
          <h2 className="sb-section-title">Your team</h2>
          <p className="hint" style={{ marginTop: 0 }}>
            Each card is one agent. The <strong>START</strong> agent goes first and hands work to the
            others. Everything here writes the same files developers edit.
          </p>
        </div>
      </div>

      {/* Auto-suggested team — fires ONCE on entering Design with an empty team and a
          stated deliverable/outputs. Non-blocking + dismissible; any failure degrades
          silently to the blank canvas + template picker below (never a dead end). */}
      <AutoProposeTeam
        systemId={systemId}
        system={system}
        canEdit={canEdit}
        onCommit={onCommit}
        onReload={onReload}
      />

      {system.agents.length === 0 ? (
        <div className="sb-empty">No agents yet — add one below, or go back and describe your team.</div>
      ) : (
        <div className="sb-agent-list">
          {system.agents.map((a, i) => (
            <AgentCard
              key={a.id}
              system={system}
              agentId={a.id}
              index={i}
              count={system.agents.length}
              canEdit={canEdit}
              catalog={catalog}
              onCommit={onCommit}
            />
          ))}
        </div>
      )}

      {picking ? (
        <AgentTemplatePicker
          systemId={systemId}
          onPickTemplate={addTemplate}
          onPickMarketplace={addMarketplace}
          onCancel={() => setPicking(false)}
        />
      ) : (
        <button className="btn ghost sm sb-add" disabled={!canEdit} onClick={() => setPicking(true)}>
          + Add agent
        </button>
      )}

      <div className="row" style={{ justifyContent: 'space-between', marginTop: 18 }}>
        <button className="btn ghost sm" onClick={onBack}>← Grant</button>
        <button className="btn" onClick={onNext} disabled={!ready} title={ready ? 'Build the team' : 'Add at least one agent first'}>
          Build →
        </button>
      </div>
    </div>
  );
}

/* ─────────────────────── Auto-suggested team (Design) ─────────────────── */

/**
 * The Design auto-proposer: on the FIRST entry to Design with an EMPTY team and a stated
 * deliverable/outputs, it calls the proposal endpoint ONCE ({stage:'design', propose:true})
 * and renders the result as a calm "Proposed team" review card stack. It NEVER blocks — a
 * shimmer while proposing, and any failure (503/402/unusable) degrades SILENTLY to the
 * blank canvas + template picker (renders nothing). Accepting commits the proposed system
 * ONCE through the existing governed path; the agents then appear as normal AgentCards.
 */
type ProposedAgentRow = { id: string; role: string; instruction: string };

function AutoProposeTeam({
  systemId, system, canEdit, onCommit, onReload,
}: {
  systemId: string;
  system: System;
  canEdit: boolean;
  onCommit: (next: System) => void;
  onReload: () => Promise<void> | void;
}) {
  const [proposing, setProposing] = useState(false);
  const [proposed, setProposed] = useState<System | null>(null);
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [dismissed, setDismissed] = useState(false);
  const firedRef = useRef(false);

  const hasAgents = system.agents.length > 0;
  const description = system.system.description ?? '';
  // GROUNDED-only auto-propose: the stage order is Define → Grant → Design, so by the time
  // the user reaches Design they should have granted context. We auto-fire ONLY when there is
  // a real deliverable AND at least one governed grant (data/knowledge/metrics/connections/
  // files/plan) — an empty-grounding goal-only proposal is exactly what made the proposer
  // free-associate ("a renewable-energy agent"), so we no longer auto-fire it. A user who
  // wants a from-goal proposal can still add agents by hand or ask the assistant "Propose a
  // team" (that path can note what each step will need).
  const g = system.grants;
  const hasGrantedContext =
    g.data.length > 0 || g.knowledge.length > 0 || g.metrics.length > 0 ||
    g.connections.length > 0 || g.files.length > 0 || g.plan.length > 0;
  const hasGoal = !!description.trim() || (system.outputs?.length ?? 0) > 0;
  const grounded = hasGoal && hasGrantedContext;

  useEffect(() => {
    // Fire ONCE per mount: only with an empty team + a GROUNDED goal, and only if editable.
    if (firedRef.current) return;
    if (hasAgents || !grounded || !canEdit || dismissed) return;
    firedRef.current = true;
    let alive = true;
    setProposing(true);
    fetch(`/api/agents/systems/${systemId}/assistant`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stage: 'design', propose: true }),
    })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        // Any non-OK (503 no-model / 402 cap / unusable) → degrade silently to blank canvas.
        if (!res.ok || !body?.proposedSystem) throw new Error(body?.error ?? 'no proposal');
        if (alive) setProposed(body.proposedSystem as System);
      })
      .catch(() => { if (alive) setProposed(null); })
      .finally(() => { if (alive) setProposing(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Nothing to show: not proposing, no proposal, or the user already has/added agents.
  if (hasAgents || dismissed) return null;
  if (proposing) {
    return (
      <div className="sb-propose sb-propose--busy" style={{ border: '1px dashed var(--border)', borderRadius: 12, padding: 14, marginBottom: 14, display: 'flex', alignItems: 'center', gap: 10 }}>
        <span className="spin" />
        <span className="hint" style={{ marginTop: 0 }}>Proposing your team from the deliverable…</span>
      </div>
    );
  }
  if (!proposed) return null;

  const rows: ProposedAgentRow[] = proposed.agents
    .filter((a) => !removed.has(a.id))
    .map((a) => ({ id: a.id, role: a.role, instruction: instructionsOf(a.agent_md) }));

  if (rows.length === 0) return null;

  const remove = (id: string) => setRemoved((s) => new Set(s).add(id));

  // Accept: commit the proposed system, dropping any per-agent removals + fixing the
  // entrypoint if it was one of the removed agents. One governed commit.
  const accept = async () => {
    const keep = proposed.agents.filter((a) => !removed.has(a.id));
    if (keep.length === 0) { setDismissed(true); return; }
    const entrypoint = keep.some((a) => a.id === proposed.entrypoint) ? proposed.entrypoint : keep[0].id;
    const next: System = { ...proposed, agents: keep, entrypoint };
    setDismissed(true);
    await onCommit(next);
    await onReload();
  };

  return (
    <div className="sb-propose" style={{ border: '1px solid var(--gold-line)', background: 'var(--gold-soft)', borderRadius: 12, padding: 14, marginBottom: 16 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <div>
          <h3 style={{ margin: 0 }}>Proposed team</h3>
          <p className="hint" style={{ marginTop: 2 }}>
            Built from your deliverable and grants. Review the wiring order, drop any you don’t want, then use it — or dismiss and design your own.
          </p>
        </div>
      </div>
      <ol className="sb-propose-list" style={{ margin: '10px 0', paddingLeft: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {rows.map((r, i) => (
          <li key={r.id} className="sb-card" style={{ padding: '10px 12px' }}>
            <div className="row" style={{ alignItems: 'center', gap: 8 }}>
              <span className="sb-card-order">{i + 1}</span>
              <span style={{ fontWeight: 650 }}>{r.role || r.id}</span>
              {i === 0 ? <span className="badge warn">START</span> : null}
              {canEdit ? (
                <button className="sb-chip-x" title="Remove before accepting" style={{ marginLeft: 'auto' }} onClick={() => remove(r.id)}>✕</button>
              ) : null}
            </div>
            {r.instruction ? <p className="hint" style={{ margin: '4px 0 0' }}>{r.instruction}</p> : null}
          </li>
        ))}
      </ol>
      <div className="row" style={{ gap: 8 }}>
        <button className="btn" onClick={accept} disabled={!canEdit || rows.length === 0}>Use this team</button>
        <button className="btn ghost sm" onClick={() => setDismissed(true)}>Dismiss</button>
      </div>
    </div>
  );
}

/**
 * The "+ Add agent" template picker. Curated role templates (from `agent-templates.ts`)
 * plus agents copied from marketplace-shared systems: it lists `/api/agents/systems`
 * (the marketplace group), then on demand fetches `/api/agents/systems/[id]` and reads
 * each node's {role, agent_md} as a copyable template. Reuses the `.tmpl-grid`/
 * `.tmpl-card` classes from NewSystemPanel.
 */
function AgentTemplatePicker({
  systemId,
  onPickTemplate,
  onPickMarketplace,
  onCancel,
}: {
  systemId: string;
  onPickTemplate: (key: AgentTemplateKey) => void;
  onPickMarketplace: (a: MarketplaceAgent) => void;
  onCancel: () => void;
}) {
  const [market, setMarket] = useState<MarketplaceAgent[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadErr, setLoadErr] = useState('');
  const [expanded, setExpanded] = useState(false);

  // Lazily load marketplace agents only when the user asks for them (avoids N fetches
  // on every "+ Add agent"). List the marketplace group, then hydrate each system's nodes.
  const loadMarketplace = async () => {
    if (market || loading) { setExpanded(true); return; }
    setLoading(true);
    setLoadErr('');
    try {
      const res = await fetch('/api/agents/systems', { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Could not load the marketplace.');
      const systems: { id: string; name: string }[] = Array.isArray(body.marketplace) ? body.marketplace : [];
      const agents: MarketplaceAgent[] = [];
      // Hydrate a bounded number of shared systems (copying text is ungated).
      for (const s of systems.slice(0, 12)) {
        if (s.id === systemId) continue;
        try {
          const one = await fetch(`/api/agents/systems/${s.id}`, { cache: 'no-store' });
          if (!one.ok) continue;
          const view = await one.json();
          for (const node of (view.system?.agents ?? []) as { role?: string; agent_md?: string }[]) {
            if (!node.role) continue;
            agents.push({ role: node.role, instructions: instructionsOf(node.agent_md ?? ''), source: s.name });
          }
        } catch { /* skip an unreadable shared system */ }
      }
      setMarket(agents);
      setExpanded(true);
    } catch (e) {
      setLoadErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="sb-resource-picker sb-add" style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 12 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span className="sb-field-label" style={{ margin: 0 }}>Add an agent — pick a starting point</span>
        <button className="btn ghost sm" onClick={onCancel}>Cancel</button>
      </div>
      <div className="tmpl-grid">
        {AGENT_TEMPLATES.map((t) => (
          <button key={t.key} type="button" className="tmpl-card" onClick={() => onPickTemplate(t.key)}>
            <span className="tmpl-label">{t.label}</span>
            <span className="tmpl-blurb">{t.blurb}</span>
          </button>
        ))}
      </div>

      <div style={{ marginTop: 12 }}>
        {!expanded ? (
          <button className="btn ghost sm" onClick={loadMarketplace} disabled={loading}>
            {loading ? <span className="spin" /> : 'Or copy an agent from the marketplace →'}
          </button>
        ) : (
          <>
            <span className="sb-field-label" style={{ margin: '0 0 6px' }}>From marketplace-shared teams</span>
            {loadErr ? <div className="error" style={{ marginBottom: 6 }}>{loadErr}</div> : null}
            {market && market.length > 0 ? (
              <div className="tmpl-grid">
                {market.map((a, i) => (
                  <button key={`${a.source}-${i}`} type="button" className="tmpl-card" title={a.source} onClick={() => onPickMarketplace(a)}>
                    <span className="tmpl-label">{a.role}</span>
                    <span className="tmpl-blurb">from {a.source}</span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="hint" style={{ marginTop: 0 }}>No marketplace agents to copy yet.</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function AgentCard({
  system,
  agentId,
  index,
  count,
  canEdit,
  catalog,
  onCommit,
}: {
  system: System;
  agentId: string;
  index: number;
  count: number;
  canEdit: boolean;
  catalog: string[] | null;
  onCommit: (next: System) => void;
}) {
  const agent = system.agents.find((a) => a.id === agentId)!;
  const isStart = system.entrypoint === agentId;

  const [role, setRole] = useState(agent.role);
  const [instr, setInstr] = useState(() => instructionsOf(agent.agent_md));
  useEffect(() => { setRole(agent.role); }, [agent.role]);
  useEffect(() => { setInstr(instructionsOf(agent.agent_md)); }, [agent.agent_md]);

  const effectiveTools = agent.tools ?? system.grants.tools;
  const auto = classifyModelNeed(effectiveTools, `${agent.id} ${role} ${instr}`);

  const saveRole = () => {
    if (role === agent.role) return;
    onCommit(setAgentRole(system, agentId, role));
  };
  const saveInstr = () => {
    if (instr === instructionsOf(agent.agent_md)) return;
    onCommit(setAgentInstructions(system, agentId, instr));
  };

  return (
    <div className={`sb-card${isStart ? ' start' : ''}`}>
      <div className="sb-card-head">
        <span className="sb-card-order">{index + 1}</span>
        {isStart ? (
          <span className="badge warn">START</span>
        ) : canEdit ? (
          <button className="btn ghost sm" onClick={() => onCommit(setEntrypoint(system, agentId))} title="Make this the first agent">Make START</button>
        ) : null}
        <div className="sb-card-tools" style={{ marginLeft: 'auto' }}>
          {canEdit ? (
            <>
              <button className="icon-btn" disabled={index === 0} title="Move up" onClick={() => onCommit(moveAgent(system, agentId, -1))}>↑</button>
              <button className="icon-btn" disabled={index === count - 1} title="Move down" onClick={() => onCommit(moveAgent(system, agentId, 1))}>↓</button>
              <button className="icon-btn danger" title="Remove agent" onClick={() => onCommit(removeAgentSimple(system, agentId))}>✕</button>
            </>
          ) : null}
        </div>
      </div>

      <label className="sb-field-label" htmlFor={`role-${agentId}`}>Name / role</label>
      <input
        id={`role-${agentId}`}
        type="text"
        value={role}
        disabled={!canEdit}
        onChange={(e) => setRole(e.target.value)}
        onBlur={saveRole}
        placeholder="e.g. Analyst — reads sources and explains the findings"
      />

      <label className="sb-field-label" htmlFor={`instr-${agentId}`} style={{ marginTop: 10 }}>Instructions</label>
      <textarea
        id={`instr-${agentId}`}
        rows={5}
        value={instr}
        disabled={!canEdit}
        onChange={(e) => setInstr(e.target.value)}
        onBlur={saveInstr}
        placeholder="Tell the agent how to work, step by step. Plain language."
      />

      <div className="sb-card-meta">
        <div className="sb-model">
          <span className="sb-field-label" style={{ margin: 0 }}>Model</span>
          <span className="badge">Auto</span>
          <span className="hint" style={{ marginTop: 0 }}>
            → {auto.need === 'fast' ? 'fast (Standard)' : 'Reasoning'} · {auto.reason}
          </span>
        </div>
      </div>

      <AgentCapabilities
        system={system}
        agentId={agentId}
        canEdit={canEdit}
        catalog={catalog}
        onCommit={onCommit}
      />
    </div>
  );
}

/* ───────────────────── Per-agent capabilities (Design) ─────────────────── */

/**
 * Per-agent capabilities in Simple mode — NO "Auto" mode and NO raw tool list.
 *
 * • The recommended capabilities are PREFILLED by default: an agent with no explicit
 *   `agent.tools` (the clean-yaml default) is shown with EVERY grant-scoped capability
 *   selected. The user changes that selection freely.
 * • The SELECTED capabilities are ALWAYS shown in a box on the card. Each is a row:
 *   click it to reveal its plain-language explanation, and a ✕ removes it.
 * • "Add capabilities" opens a picker window listing the available capabilities grouped
 *   PER DOMAIN (Data · Knowledge · Files · …), each described, ticked to select. Only
 *   capabilities the TEAM's grants permit are offered (grant-scoping is preserved).
 *
 * Persistence: the selection maps to a narrowed `agent.tools` subset of `grants.tools`.
 * When the selection equals the full recommended set we clear `agent.tools` (undefined)
 * so the file stays byte-stable and the agent keeps inheriting the recommended default.
 */
function AgentCapabilities({
  system,
  agentId,
  canEdit,
  catalog,
  onCommit,
}: {
  system: System;
  agentId: string;
  canEdit: boolean;
  catalog: string[] | null;
  onCommit: (next: System) => void;
}) {
  const agent = system.agents.find((a) => a.id === agentId)!;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Capabilities the team's grants actually permit (the recommended default set).
  const offeredChips = useMemo(
    () => capabilityChipsForGrants(system.grants, catalog),
    [system.grants, catalog],
  );
  const offeredIds = useMemo(() => offeredChips.map((c) => c.id), [offeredChips]);
  const chipById = useMemo(() => new Map(offeredChips.map((c) => [c.id, c])), [offeredChips]);

  // Selected ids = explicit narrowing (agent.tools) reverse-mapped to chips, else the
  // full recommended set (prefill). Always intersected with what's currently offered
  // so a revoked grant drops its capability from the box.
  const selectedIds = useMemo(() => {
    const base = agent.tools ? chipIdsForTools(agent.tools) : offeredIds;
    return base.filter((id) => offeredIds.includes(id));
  }, [agent.tools, offeredIds]);

  // Persist a new selection: full recommended set → clear the narrowing (undefined);
  // otherwise store the narrowed tool subset (⊆ grants.tools).
  const persist = (nextIds: string[]) => {
    if (!canEdit) return;
    const isFull = offeredIds.length > 0 && nextIds.length === offeredIds.length
      && offeredIds.every((id) => nextIds.includes(id));
    let tools: string[] | undefined;
    if (isFull) {
      tools = undefined;
    } else {
      // Pool-aware: each selected chip resolves to its kind's read ∪ granted-write tools
      // ∩ the team pool — so a capability keeps the write access the team was granted
      // (not just read). The ∩ pool keeps the agent ⊆ grants.tools (never widens).
      const narrow = toolsForCapabilityChipsInPool(nextIds, system.grants.tools);
      tools = narrow.length > 0 ? narrow : [];
    }
    onCommit({ ...system, agents: system.agents.map((a) => a.id === agentId ? { ...a, tools } : a) });
  };

  const removeCap = (id: string) => persist(selectedIds.filter((s) => s !== id));

  return (
    <div className="sb-tools">
      <div className="row" style={{ alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <span className="sb-field-label" style={{ margin: 0 }}>Capabilities</span>
        {canEdit && offeredChips.length > 0 ? (
          <button type="button" className="btn ghost sm" onClick={() => setPickerOpen(true)}>
            + Add capabilities
          </button>
        ) : null}
      </div>

      {offeredChips.length === 0 ? (
        <p className="hint" style={{ marginTop: 0, marginBottom: 0 }}>
          No capabilities available yet — grant the team some data, knowledge, files or connections first (on Define).
        </p>
      ) : selectedIds.length === 0 ? (
        <p className="hint" style={{ marginTop: 0, marginBottom: 0 }}>
          No capabilities selected — this agent can’t use any tools. Add some above.
        </p>
      ) : (
        // The always-visible box of SELECTED capabilities. Each row expands to its
        // explanation on click and carries a ✕ to remove it.
        <div className="sb-cap-box">
          {selectedIds.map((id) => {
            const chip = chipById.get(id);
            if (!chip) return null;
            const open = expandedId === id;
            return (
              <div key={id} className={`sb-cap-row${open ? ' open' : ''}`}>
                <div className="sb-cap-row-head">
                  <button
                    type="button"
                    className="sb-cap-row-name"
                    aria-expanded={open}
                    onClick={() => setExpandedId(open ? null : id)}
                    title="Show what this does"
                  >
                    <span className="badge muted" style={{ marginRight: 6 }}>{chip.domain}</span>
                    {chip.label}
                    <span className="sb-cap-caret" aria-hidden>{open ? '▾' : '▸'}</span>
                  </button>
                  {canEdit ? (
                    <button className="sb-chip-x" title="Remove capability" onClick={() => removeCap(id)}>✕</button>
                  ) : null}
                </div>
                {open ? <p className="sb-cap-desc hint" style={{ margin: '4px 0 0' }}>{chip.description}</p> : null}
              </div>
            );
          })}
        </div>
      )}

      {pickerOpen ? (
        <CapabilityPicker
          offered={offeredChips}
          selectedIds={selectedIds}
          onApply={(ids) => { persist(ids); setPickerOpen(false); }}
          onClose={() => setPickerOpen(false)}
        />
      ) : null}
    </div>
  );
}

/**
 * The capability picker WINDOW — a modal listing the available capabilities grouped by
 * DOMAIN (Data · Knowledge · Files · …), each described, ticked to select. Only the
 * capabilities passed in `offered` (already grant-scoped) appear, so it never widens
 * access. Applying commits the selection; nothing persists until Apply.
 */
function CapabilityPicker({
  offered,
  selectedIds,
  onApply,
  onClose,
}: {
  offered: CapabilityChip[];
  selectedIds: string[];
  onApply: (ids: string[]) => void;
  onClose: () => void;
}) {
  const [picked, setPicked] = useState<Set<string>>(() => new Set(selectedIds));
  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  // Group by domain in the offered order.
  const groups = useMemo(() => {
    const m = new Map<string, CapabilityChip[]>();
    for (const c of offered) {
      const arr = m.get(c.domain) ?? [];
      arr.push(c);
      m.set(c.domain, arr);
    }
    return [...m.entries()];
  }, [offered]);

  return (
    <div className="sb-cap-scrim" onClick={onClose}>
      <div className="sb-cap-modal" role="dialog" aria-label="Choose capabilities" onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>Choose capabilities</h3>
          <button className="btn ghost sm" onClick={onClose}>Cancel</button>
        </div>
        <p className="hint" style={{ marginTop: 0 }}>
          Only what your team was granted is shown. Tick a capability to give this agent access.
        </p>
        <div className="sb-cap-groups">
          {groups.map(([domain, chips]) => (
            <div key={domain} className="sb-cap-group">
              <div className="sb-field-label" style={{ margin: '2px 0 4px' }}>{domain}</div>
              {chips.map((c) => {
                const on = picked.has(c.id);
                return (
                  <label key={c.id} className={`sb-cap-option${on ? ' on' : ''}`}>
                    <input type="checkbox" checked={on} onChange={() => toggle(c.id)} style={{ accentColor: 'var(--gold-deep)' }} />
                    <span className="sb-cap-option-body">
                      <span className="sb-cap-option-name">{c.label}</span>
                      <span className="sb-cap-option-desc">{c.description}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          ))}
        </div>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button className="btn" onClick={() => onApply([...picked])}>Apply</button>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────── Trigger mode (Define) ─────────────────────────── */

type TriggerKind = 'manual' | 'cron' | 'event';
const TRIGGER_CARDS: { kind: TriggerKind; label: string; blurb: string }[] = [
  { kind: 'manual', label: 'Manual', blurb: 'You run it by hand, right here.' },
  { kind: 'cron', label: 'On schedule', blurb: 'It runs automatically on a repeating schedule.' },
  { kind: 'event', label: 'Called from system', blurb: 'Another system or the API triggers it on demand.' },
];

/**
 * The Define-phase trigger-mode selector — three cards (Manual · On schedule · Called from
 * system), each showing its settings when chosen. It reuses the working schedule route
 * (`/schedule`): "On schedule" edits a cron; "Called from system" shows the MCP/API
 * caller hint and persists an `event` schedule. The schedule is a first-class part of
 * system.yaml already, so nothing new is persisted.
 */
function TriggerMode({
  systemId, system, canEdit, onReload,
}: {
  systemId: string;
  system: System;
  canEdit: boolean;
  onReload: () => void | Promise<void>;
}) {
  const toast = useToast();
  const current: TriggerKind = system.schedule?.kind ?? 'manual';
  const [kind, setKind] = useState<TriggerKind>(current);
  const [cron, setCron] = useState(system.schedule?.cron ?? '0 9 * * 1');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  useEffect(() => { setKind(system.schedule?.kind ?? 'manual'); }, [system.schedule?.kind]);
  useEffect(() => { if (system.schedule?.cron) setCron(system.schedule.cron); }, [system.schedule?.cron]);

  const save = async (next: { kind: TriggerKind; cron?: string; event?: string }) => {
    setBusy(true);
    setErr('');
    setNote('');
    try {
      const res = await fetch(`/api/agents/systems/${systemId}/schedule`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(next),
      });
      const b = await res.json();
      if (!res.ok) throw new Error(b.error ?? 'Could not update the trigger.');
      if (b.cron && next.kind === 'cron') {
        setNote(b.cron.ok && b.cron.live ? `✓ CronJob ${b.cron.action} — runs on schedule` : `⚠ schedule saved but not scheduled — ${b.cron.detail}`);
      }
      const TRIGGER_WORD: Record<TriggerKind, string> = { manual: 'Manual', cron: 'Scheduled', event: 'On-demand' };
      toast.success(`Trigger set to ${TRIGGER_WORD[next.kind]}`);
      await onReload();
    } catch (e) {
      const msg = (e as Error).message;
      setErr(msg);
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  };

  const pick = (next: TriggerKind) => {
    setKind(next);
    void save(next === 'cron' ? { kind: 'cron', cron } : next === 'event' ? { kind: 'event', event: 'on_demand' } : { kind: 'manual' });
  };

  return (
    <div className="sb-resources" style={{ marginBottom: 16 }}>
      <h2 className="sb-section-title" style={{ marginTop: 0 }}>How is this team triggered?</h2>
      <div className="tmpl-grid" role="group" aria-label="Trigger mode">
        {TRIGGER_CARDS.map((c) => (
          <button
            key={c.kind}
            type="button"
            className={`tmpl-card${kind === c.kind ? ' active' : ''}`}
            aria-pressed={kind === c.kind}
            disabled={!canEdit || busy}
            onClick={() => canEdit && kind !== c.kind && pick(c.kind)}
          >
            <span className="tmpl-label">{c.label}</span>
            <span className="tmpl-blurb">{c.blurb}</span>
          </button>
        ))}
      </div>

      {kind === 'cron' ? (
        <div style={{ marginTop: 10 }}>
          <label className="sb-field-label">When should it run?</label>
          <RecurrenceEditor
            cron={cron}
            disabled={!canEdit || busy}
            onChange={(next) => { setCron(next); void save({ kind: 'cron', cron: next }); }}
          />
        </div>
      ) : null}

      {kind === 'event' ? (
        <div style={{ marginTop: 10 }} className="hint">
          Trigger it from another system or the API with{' '}
          <span className="mono">run_agent_system</span> (MCP) or{' '}
          <span className="mono">POST /api/agents/systems/{systemId}/run</span>. No schedule is set — it runs when called.
        </div>
      ) : null}

      {err ? <div className="error" style={{ marginTop: 8 }}>{err}</div> : null}
      {note ? <div className="hint" style={{ marginTop: 8 }}>{note}</div> : null}
    </div>
  );
}

/* ─────────────────────────── Phase 5 — Evaluate ─────────────────────────── */

/** The four node verdicts the diagnostics/checks understand. */
type DiagStatus = 'ok' | 'denied' | 'error' | 'failed';
const DIAG_STATUSES = new Set<DiagStatus>(['ok', 'denied', 'error', 'failed']);
function toDiagStatus(s: string): DiagStatus {
  return DIAG_STATUSES.has(s as DiagStatus) ? (s as DiagStatus) : 'ok';
}

/** Map the persisted LastRun into the DiagRun shape the deterministic checks consume. */
function lastRunToDiag(lastRun: NonNullable<BuildRunProps['lastRun']>): DiagRun {
  return {
    ok: lastRun.ok,
    path: lastRun.path ?? [],
    output: lastRun.output,
    nodes: (lastRun.nodes ?? []).map((n) => ({
      node: n.node,
      status: toDiagStatus(n.status),
      // The persisted step has no errorKind — an errored step counts as an exec error.
      steps: (n.steps ?? []).map((s) => ({ tool: s.tool, isError: s.isError })),
    })),
  };
}

/**
 * "Save result → <output>" — persists the last run's final text into each DECLARED
 * output (Define → Outputs) through the governed create the tabs use (the outputs/save
 * route). File and Knowledge are the natural cases; a Dataset save is offered ONLY when
 * the result is CSV/tabular (`canSaveFromResult`) — otherwise the team's own write tools
 * (enabled by the declared Write grant) are the path, and we say so. Nothing renders when
 * no outputs are declared.
 */
function SaveResultBlock({
  systemId, system, output, canEdit,
}: {
  systemId: string;
  system: System;
  /** The last run's final text. */
  output: string;
  canEdit: boolean;
}) {
  const toast = useToast();
  const outputs = system.outputs ?? [];
  const [busyIdx, setBusyIdx] = useState<number | null>(null);
  const kindLabel = (k: OutputKind) => (k === 'files' ? 'File' : k === 'data' ? 'Dataset' : 'Knowledge');

  if (outputs.length === 0) return null;

  const save = async (index: number) => {
    if (busyIdx !== null) return;
    setBusyIdx(index);
    try {
      const res = await fetch(`/api/agents/systems/${systemId}/outputs/save`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ index, text: output }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Could not save the result.');
      toast.success(`Saved to ${kindLabel(outputs[index].kind)} “${outputs[index].name}”`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusyIdx(null);
    }
  };

  return (
    <div className="sb-save-outputs" style={{ marginBottom: 14 }}>
      <h2 className="sb-section-title" style={{ marginTop: 0 }}>Save the result</h2>
      <p className="hint" style={{ marginTop: 0 }}>
        Store this run’s result in a destination you declared on Define.
      </p>
      <div className="sb-out-list">
        {outputs.map((o, i) => {
          const canSave = canSaveFromResult(o, output);
          return (
            <div key={`${o.kind}:${o.folder.scope}:${o.folder.path}:${o.name}:${i}`} className="sb-out-row">
              <span className="badge muted">{kindLabel(o.kind)}</span>
              <span className="sb-out-name">{o.name}</span>
              <span className="sb-out-dest hint" style={{ marginTop: 0 }}>
                → 📁 {o.folder.path === '/' ? 'root' : o.folder.path}
              </span>
              <span style={{ marginLeft: 'auto' }}>
                {canSave ? (
                  <button className="btn ghost sm" disabled={!canEdit || busyIdx !== null} onClick={() => save(i)}>
                    {busyIdx === i ? <span className="spin" /> : `Save result → ${o.name}`}
                  </button>
                ) : (
                  <span className="hint" style={{ marginTop: 0 }} title={DATA_NON_TABULAR_NOTE}>
                    {o.kind === 'data' ? 'Written by the team during a run' : 'No result to save yet'}
                  </span>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Phase 5 — Evaluate. Deterministic checks (green/red) + a one-click LLM-judge that
 * scores Clarity · Grounding · Actionability against the system's task Description via
 * the governed assistant model (the evaluate route). Diagnostics/PDF/trace live below,
 * relocated into the shared panel's `evaluate` phase.
 */
function EvaluateStep({
  systemId, system, lastRun, canEdit,
}: {
  systemId: string;
  system: System;
  lastRun: BuildRunProps['lastRun'];
  canEdit: boolean;
}) {
  const { user } = useUser();
  const [judge, setJudge] = useState<JudgeResult | null>(null);
  const [judging, setJudging] = useState(false);
  const [judgeErr, setJudgeErr] = useState('');
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfErr, setPdfErr] = useState('');

  const checks = useMemo(() => (lastRun ? runChecks(lastRunToDiag(lastRun)) : []), [lastRun]);
  const output = lastRun?.output ?? '';

  // The Evaluate PDF: the visual graph first, then the on-screen Evaluate content
  // (checks + AI judge — the judge only when it has actually been run), then the
  // three mandated appendices (Results · Define settings · Agent descriptions).
  const downloadEval = async () => {
    if (!lastRun) return;
    setPdfBusy(true);
    setPdfErr('');
    try {
      await downloadEvalPdf(system, lastRunToDiag(lastRun), checks, judge, {
        ranBy: user?.name ?? 'unknown',
        at: lastRun.at ?? Date.now(),
      });
    } catch (e) {
      setPdfErr(`Could not generate the PDF report: ${(e as Error).message}`);
    } finally {
      setPdfBusy(false);
    }
  };

  const runJudge = async () => {
    if (judging) return;
    setJudging(true);
    setJudgeErr('');
    try {
      const res = await fetch(`/api/agents/systems/${systemId}/evaluate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ output }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'The judge could not score this run.');
      setJudge(body as JudgeResult);
    } catch (e) {
      setJudgeErr((e as Error).message);
    } finally {
      setJudging(false);
    }
  };

  if (!lastRun) {
    return <div className="sb-empty">No run to evaluate yet — run the team first.</div>;
  }

  return (
    <div className="sb-resources" style={{ marginBottom: 12 }}>
      {/* The Evaluate PDF button sits ABOVE the content it captures: the visual graph,
          then this on-screen Evaluate content, then the three appendices. */}
      <div className="row" style={{ justifyContent: 'flex-end', marginBottom: 6 }}>
        <button
          className="btn ghost"
          onClick={downloadEval}
          disabled={pdfBusy}
          title="Download a PDF: the system graph, this evaluation, and the results / settings / agent appendices"
        >
          {pdfBusy ? <span className="spin" /> : 'Download PDF Evaluation Report'}
        </button>
      </div>
      {pdfErr ? <div className="error" style={{ marginBottom: 8 }}>{pdfErr}</div> : null}

      {/* Save the result into a declared output (Define → Outputs). */}
      <SaveResultBlock systemId={systemId} system={system} output={output} canEdit={canEdit} />

      {/* Deterministic checks — green/red, zero-cost, no model. */}
      <div className="row" style={{ alignItems: 'center', gap: 8 }}>
        <h2 className="sb-section-title" style={{ margin: 0 }}>Checks</h2>
        <span className={`badge ${allChecksPass(checks) ? 'ok' : 'warn'}`}>
          {allChecksPass(checks) ? '✓ all passed' : `${checks.filter((c) => !c.pass).length} to look at`}
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
        {checks.map((c) => (
          <div key={c.id} className="row" style={{ alignItems: 'baseline', gap: 8 }}>
            <span className={`badge ${c.pass ? 'ok' : 'err'}`} style={{ minWidth: 22, textAlign: 'center' }}>{c.pass ? '✓' : '✗'}</span>
            <span style={{ fontWeight: 600, minWidth: 160 }}>{c.label}</span>
            <span className="hint" style={{ marginTop: 0 }}>{c.detail}</span>
          </div>
        ))}
      </div>

      {/* LLM-judge — one click, scores against the system's task Description.
          Marked EXPERIMENTAL: LLM-as-judge scoring is indicative, not authoritative. */}
      <div className="row" style={{ alignItems: 'center', gap: 8, marginTop: 18 }}>
        <h2 className="sb-section-title" style={{ margin: 0 }}>AI judge</h2>
        <span className="badge warn" title="Experimental — LLM-as-judge scores are indicative, not a reliable measure of quality yet">Experimental</span>
        <button className="btn primary" onClick={runJudge} disabled={judging || !canEdit || !output.trim()} title={output.trim() ? 'Score this run with the AI judge' : 'No output to judge'}>
          {judging ? <span className="spin" /> : judge ? 'Re-judge' : 'Judge this run'}
        </button>
      </div>
      <p className="hint" style={{ marginTop: 4 }}>
        The standard model scores the final output against what this team is meant to do — Clarity, Grounding, Actionability (1–5).
        <br />
        <strong>Experimental:</strong> LLM-as-judge scoring is still being developed — treat scores as a rough signal, not a definitive measure. Use your own judgement alongside it.
      </p>
      {judgeErr ? <div className="error" style={{ marginTop: 6 }}>{judgeErr}</div> : null}
      {judge ? (
        <div style={{ marginTop: 8 }}>
          <div className="row" style={{ alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span className="badge ok" style={{ fontSize: 13 }}>Overall {judge.overall}/5</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {judge.scores.map((s) => (
              <div key={s.dimension} className="sb-card" style={{ padding: '10px 12px' }}>
                <div className="row" style={{ alignItems: 'center', gap: 8 }}>
                  <span style={{ fontWeight: 650 }}>{dimensionLabel(s.dimension)}</span>
                  <span className="badge">{s.score}/5</span>
                </div>
                <p className="hint" style={{ marginTop: 4, marginBottom: 0 }}>{s.why}</p>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ─────────────────────────── Outputs (Define) ─────────────────────────── */

/** A DLS-scoped folder row from the grants-available feed (path + scope). */
type FolderNode = { path: string; scope: 'personal' | 'domain' };

/** The three destination kinds a declared output can target, with plain labels. */
const OUTPUT_KIND_CARDS: { kind: OutputKind; label: string; feedKind: 'files' | 'data' | 'knowledge' }[] = [
  { kind: 'files', label: 'File', feedKind: 'files' },
  { kind: 'data', label: 'Dataset', feedKind: 'data' },
  { kind: 'knowledge', label: 'Knowledge', feedKind: 'knowledge' },
];

/**
 * "Where the results go" — DECLARED OUTPUTS. Each row picks a destination Type
 * (File · Dataset · Knowledge), a Name, a Folder (existing or ＋ New folder) and a
 * Scope (My / Domain). Declaring an output auto-grants the team **Write** to that
 * folder (reusing the grant/write-tool machinery — see `addOutput`); the folder
 * materialises when the first result is saved. Consistent with the grants picker.
 */
function OutputsSection({
  systemId, system, canEdit, onCommit,
}: {
  systemId: string;
  system: System;
  canEdit: boolean;
  onCommit: (next: System) => void;
}) {
  // Folders per kind, from the DLS-scoped grants-available feed (one fetch per kind).
  const [foldersByKind, setFoldersByKind] = useState<Record<string, FolderNode[]>>({});
  useEffect(() => {
    let alive = true;
    Promise.all(OUTPUT_KIND_CARDS.map(async (c) => {
      try {
        const res = await fetch(`/api/agents/systems/${systemId}/grants/available?kind=${c.feedKind}`, { cache: 'no-store' });
        const body = await res.json();
        return [c.kind, res.ok ? ((body.folders as FolderNode[]) ?? []) : []] as const;
      } catch { return [c.kind, [] as FolderNode[]] as const; }
    })).then((pairs) => { if (alive) setFoldersByKind(Object.fromEntries(pairs)); });
    return () => { alive = false; };
  }, [systemId]);

  const outputs = system.outputs ?? [];

  // Draft row state (Type/Name/Folder/Scope) — persisted only on "Add output".
  const [draftKind, setDraftKind] = useState<OutputKind>('files');
  const [draftName, setDraftName] = useState('');
  const [draftScope, setDraftScope] = useState<'personal' | 'domain'>('personal');
  const [draftFolder, setDraftFolder] = useState('/');

  const foldersFor = (kind: OutputKind, scope: 'personal' | 'domain'): string[] =>
    (foldersByKind[kind] ?? []).filter((f) => f.scope === scope).map((f) => f.path);

  const addRow = () => {
    if (!canEdit || !draftName.trim()) return;
    onCommit(addOutput(system, {
      kind: draftKind,
      name: draftName.trim(),
      folder: { path: normaliseFolderPath(draftFolder), scope: draftScope },
    }));
    setDraftName(''); setDraftFolder('/');
  };

  const kindLabel = (k: OutputKind) => OUTPUT_KIND_CARDS.find((c) => c.kind === k)?.label ?? k;

  return (
    <div className="sb-resources sb-outputs" style={{ marginTop: 16 }}>
      <h2 className="sb-section-title" style={{ marginTop: 0 }}>Where the results go</h2>
      <p className="hint" style={{ marginTop: 0 }}>
        Declare where this team stores its results — a File, Dataset or Knowledge item, in an existing
        or new folder. Declaring an output grants the team Write to this folder; the folder appears when
        the first result is saved.
      </p>

      {outputs.length > 0 ? (
        <div className="sb-out-list">
          {outputs.map((o, i) => (
            <div key={`${o.kind}:${o.folder.scope}:${o.folder.path}:${o.name}:${i}`} className="sb-out-row">
              <span className="badge muted">{kindLabel(o.kind)}</span>
              <span className="sb-out-name">{o.name}</span>
              <span className="sb-out-dest hint" style={{ marginTop: 0 }}>
                → 📁 {o.folder.path === '/' ? 'root' : o.folder.path}
                <span className="badge muted" style={{ marginLeft: 6 }}>{scopeLabel(o.folder.scope === 'domain' ? 'shared' : 'mine')}</span>
              </span>
              {canEdit ? (
                <button className="sb-chip-x" title="Remove output" style={{ marginLeft: 'auto' }} onClick={() => onCommit(removeOutput(system, i))}>✕</button>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <p className="hint" style={{ marginTop: 0, marginBottom: 0 }}>No outputs declared yet — add one below.</p>
      )}

      {canEdit ? (
        <div className="sb-out-add">
          <div className="sb-out-add-fields">
            <label className="sb-field-label" style={{ margin: 0 }}>Type</label>
            <select value={draftKind} onChange={(e) => setDraftKind(e.target.value as OutputKind)}>
              {OUTPUT_KIND_CARDS.map((c) => <option key={c.kind} value={c.kind}>{c.label}</option>)}
            </select>

            <label className="sb-field-label" style={{ margin: 0 }}>Name</label>
            <input
              type="text"
              value={draftName}
              placeholder={draftKind === 'data' ? 'e.g. Scored campaigns' : 'e.g. Weekly report'}
              onChange={(e) => setDraftName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addRow(); } }}
              style={{ minWidth: 180 }}
            />

            <label className="sb-field-label" style={{ margin: 0 }}>Scope</label>
            <span className="sb-out-scope" role="radiogroup" aria-label="Output scope" style={{ display: 'inline-flex', gap: 2 }}>
              {(['personal', 'domain'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={draftScope === s}
                  className={`sb-access-seg-btn${draftScope === s ? ' active' : ''}`}
                  onClick={() => { if (draftScope !== s) { setDraftScope(s); setDraftFolder('/'); } }}
                >
                  {s === 'domain' ? 'Domain' : 'My'}
                </button>
              ))}
            </span>

            <label className="sb-field-label" style={{ margin: 0 }}>Folder</label>
            <NewFolderField
              folders={foldersFor(draftKind, draftScope)}
              value={draftFolder}
              scope={draftScope}
              canEdit={canEdit}
              onChange={setDraftFolder}
            />
          </div>
          <button type="button" className="btn ghost sm sb-out-addbtn" disabled={!draftName.trim()} onClick={addRow}>
            + Add output
          </button>
        </div>
      ) : null}
    </div>
  );
}