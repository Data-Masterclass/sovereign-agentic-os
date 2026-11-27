/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import BuildRunPanel from '@tabs/agents/ui/BuildRunPanel';
import RecurrenceEditor from '@tabs/agents/ui/RecurrenceEditor';
import GrantStage from '@tabs/agents/ui/GrantStage';
import AgentStageAssistant from '@tabs/agents/ui/AgentStageAssistant';
import AgentEditorDialog from '@tabs/agents/ui/AgentEditorDialog';
import { NewFolderField } from '@tabs/agents/ui/GrantPickers';
import type { System, OutputKind } from '@tabs/agents/lib/system-schema';
import { classifyModelNeed } from '@tabs/agents/lib/routing';
import { instructionsOf } from '@tabs/agents/lib/agent-md';
import {
  addSimpleAgent, moveAgent, removeAgentSimple,
  setAgentInstructions, setAgentRole,
  setDescription, addSystemTool,
  addOutput, removeOutput, setOutputAgent,
} from '@tabs/agents/lib/simple-edit';
import { outputLanding, outputCaveats, agentOutputTools } from '@tabs/agents/lib/output-tools';
import {
  agentCapabilityState, useEverything, addMissingCapability, toolsForSelection,
} from '@tabs/agents/lib/agent-capabilities';
import { useToast } from '@core/ui/core/Toast';
import { normaliseFolderPath } from '@core/kernel/folders';

import {
  capabilityChipsForGrants, toolsForCapabilityChipsInPool, chipIdsForTools,
  type CapabilityChip,
} from '@tabs/agents/lib/capability-tools';
import { setEntrypoint } from '@tabs/agents/lib/canvas-edit';
import RunOutputs from '@tabs/agents/ui/RunOutputs';
import { outputKey, type OutputResult } from '@tabs/agents/lib/output-saver';
import {
  EMPTY_OUTPUT_DRAFT, outputDraftDirty, outputDraftValid,
  outputDraftStorageKey, serializeOutputDraft, parseOutputDraft,
  type OutputDraft,
} from '@tabs/agents/lib/output-draft';
import { AGENT_TEMPLATES, agentTemplate, type AgentTemplateKey } from '@tabs/agents/lib/agent-templates';
import StageShell from '@core/ui/core/StageShell';
import { usePublishPageContext } from '@core/ui/core/PageContext';
import {
  advance, goTo, initialStageState,
  type StageState,
} from '@core/kernel/stages';
import { AGENT_STAGES, agentStageCtx, type AgentStageId, type AgentStageCtx } from '@tabs/agents/lib/stages';
import { localizeAgentStages } from '@tabs/agents/lib/stage-labels';
import { useEmptyGrants } from '@tabs/agents/ui/useEmptyGrants';
import { runChecks, allChecksPass } from '@tabs/agents/lib/build/run-checks';
import type { DiagRun } from '@tabs/agents/lib/build/run-diagnostics';
import { dimensionLabel, type JudgeResult } from '@tabs/agents/lib/evaluate-judge';
import { downloadEvalPdf } from '@tabs/agents/lib/build/agent-pdf';
import { useUser } from '@core/ui/useUser';
import { scheduleSavedNote } from '@tabs/agents/lib/schedule-note';
import { capabilityStateMessage, staleLimitMessage, capabilityLabelMessage } from '@tabs/agents/lib/agent-capabilities';
import { chipKeys, chipDomainKey, templateKeys, dimensionKey } from '@tabs/agents/lib/builder-labels';
import { useTranslations, useFormat } from '@core/i18n/client';

type AgentsT = ReturnType<typeof useTranslations<'agents'>>;
/** Render a catalog key a pure module returned (keys relative to the `agents` namespace). */
function tk(t: AgentsT, m: { key: string; args?: Record<string, string | number> }): string {
  return t(m.key as Parameters<AgentsT>[0], m.args);
}
/** A capability chip's label / description / group in the user's language (English source as fallback). */
function chipText(t: AgentsT, chip: CapabilityChip, field: 'label' | 'description'): string {
  const k = chipKeys(chip.id);
  return k ? tk(t, { key: k[field] }) : chip[field];
}
function domainText(t: AgentsT, domain: string): string {
  const k = chipDomainKey(domain);
  return k ? tk(t, { key: k }) : domain;
}
/** A capability label from agent-capabilities ("File saving") in the user's language. */
function capLabelText(t: AgentsT, english: string): string {
  const m = capabilityLabelMessage(english);
  return m ? tk(t, m) : english;
}

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
  // here, never jumping ahead. `stage` is ONLY the position: a phase's ✓ is derived from
  // the saved system + its last build/run (`ctx` below), so it is the same on first open,
  // after a reload and for a colleague — never a record of which buttons were pressed
  // (the shared stage model, core/kernel/stages.ts).
  const t = useTranslations('agents');
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

  // ── the unsaved-output guard ──────────────────────────────────────────────
  // "Where the results go" keeps a typed output as a DRAFT until it is saved, and the
  // Define stage unmounts on every exit — the rail, "Grant context →", a back button — so
  // the author filled the fields, moved on, and came back to an empty row ("it reset").
  // The guard therefore lives HERE, with the component that owns the transitions: the
  // section only reports `{ dirty, valid, save, discard }` upward. A guard inside the
  // section would cover none of those exits (the same lesson as the knowledge editor's
  // `editor-guard.ts`), and two guards on one exit ask the user twice.
  //
  // The two FLAGS are mirrored into state as well as the ref. A ref does not re-render, so a
  // prompt whose Save button read `outputDraft.current.valid` was frozen at whatever validity
  // held when the prompt opened — it could never enable. The CALLBACKS stay in the ref (they
  // are re-registered on every keystroke, and re-rendering the builder for each would be a
  // waste); only the flags the UI renders go through state.
  const outputDraft = useRef<OutputDraftState>(EMPTY_OUTPUT_DRAFT_STATE);
  const [draftFlags, setDraftFlags] = useState<{ dirty: boolean; valid: boolean }>({ dirty: false, valid: false });
  const onOutputDraftState = useCallback((state: OutputDraftState) => {
    outputDraft.current = state;
    setDraftFlags((prev) => (
      prev.dirty === state.dirty && prev.valid === state.valid ? prev : { dirty: state.dirty, valid: state.valid }
    ));
  }, []);
  const [pendingStage, setPendingStage] = useState<StageState<AgentStageId> | null>(null);
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

  // What the PHASES gates and ✓s read: SAVED state only (the system as committed, its last
  // build, its last run) — see `agentStageCtx`. `checksPass` is asked only when a run exists.
  // `emptyGrants` = the folder grants that match nothing today (loaded here, not in the grant
  // pickers, so the Grant step does not depend on that stage having been opened).
  const emptyGrants = useEmptyGrants(systemId, system);
  const ctx: AgentStageCtx = agentStageCtx({
    system,
    emptyGrants,
    lastBuild: buildRun.lastBuild,
    lastRun: buildRun.lastRun,
    checksPass: (run) => allChecksPass(runChecks(lastRunToDiag(run))),
  });

  // Every transition goes through the shared stage model: `go` jumps (entry-gated),
  // `next` advances one phase. Neither records anything — ✓s come from `ctx`. All of them
  // (and the rail, via `onState`) funnel through `applyStage`, the ONE exit the
  // unsaved-output guard watches.
  // The transition is applied through the FUNCTIONAL `setStage` form (never a value computed
  // from the rendered `stage`), so a transition that lands after another state update still
  // reduces over the current state. The guard only needs to know WHERE it would land, which a
  // probe over the rendered state answers.
  const applyStage = (update: (s: StageState<AgentStageId>) => StageState<AgentStageId>) => {
    const draft = outputDraft.current;
    if (phase === 'define' && draft.dirty) {
      const probe = update(stage);
      if (probe.current !== 'define') {
        // Complete enough to keep? Keep it — there is nothing to ask. Otherwise ask, and
        // do not move until the author has answered.
        if (draft.valid) draft.save();
        else { setPendingStage(probe); return; }
      }
    }
    setStage(update);
  };
  // The rail's titles and reasons in the user's language; gates and ✓ rules are PHASES' own.
  const railStages = useMemo(() => localizeAgentStages(PHASES, (k) => t(k as Parameters<typeof t>[0])), [t]);
  const go = (id: AgentStageId) => applyStage((s) => goTo(PHASES, s, id, ctx));
  const next = () => applyStage((s) => advance(PHASES, s, ctx));

  /** Resolve the unsaved-output prompt. `keep` stays put; nothing is ever discarded silently. */
  const answerOutputGuard = (choice: 'save' | 'discard' | 'keep') => {
    const target = pendingStage;
    if (choice === 'keep' || !target) { setPendingStage(null); return; }
    const draft = outputDraft.current;
    if (choice === 'save') {
      if (!draft.valid) return; // an incomplete output cannot be saved — stay on the stage
      draft.save();
    } else {
      draft.discard();
    }
    setPendingStage(null);
    setStage(() => target);
  };

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
          jumps + state-derived ✓s. Headers/footers stay bespoke per phase (below), so the
          shell renders rail-only. */}
      <StageShell
        stages={railStages}
        state={stage}
        ctx={ctx}
        onState={(s) => applyStage(() => s)}
        ariaLabel={t('builder.phasesAria')}
        showHeader={false}
        showNav={false}
        aside={
          // Runtime badge — read-only, tells the author which engine runs their team.
          hasAgents ? (
            <span className="badge" title={t('builder.runtimeBadgeTitle', { runtime: system.runtime })}>
              {t('builder.runtimeBadge')}
            </span>
          ) : null
        }
      >

      {err ? <div className="error" style={{ marginBottom: 12 }}>{err}</div> : null}

      {/* The unsaved-output prompt — one prompt, for every way out of Define. It only
          appears for a draft that cannot be saved as it stands; a complete one is simply
          saved on the way out. */}
      {pendingStage ? (
        <div
          className="row"
          style={{
            gap: 8, alignItems: 'center', marginBottom: 12, padding: '8px 10px',
            border: '1px solid var(--amber, #b58900)', borderRadius: 6,
          }}
        >
          <span>
            {draftFlags.valid ? t('builder.outputGuard.unsaved') : t('builder.outputGuard.unsavedNeedsName')}
          </span>
          <button
            className="btn sm"
            disabled={!draftFlags.valid}
            title={draftFlags.valid ? t('builder.outputGuard.saveTitle') : t('builder.outputGuard.nameFirst')}
            onClick={() => answerOutputGuard('save')}
          >
            {t('builder.outputGuard.save')}
          </button>
          <button className="btn ghost sm" onClick={() => answerOutputGuard('discard')}>{t('builder.outputGuard.discard')}</button>
          <button className="btn ghost sm" onClick={() => answerOutputGuard('keep')}>{t('builder.outputGuard.keep')}</button>
        </div>
      ) : null}

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
            onOutputDraftState={onOutputDraftState}
            lastOutputs={buildRun.lastRun?.outputs}
          />
        </div>
      ) : null}

      {phase === 'grant' ? (
        <div>
          {assistant}
          <GrantStage systemId={systemId} system={system} canEdit={editable} onCommit={commit} />
          {ctx.grantCount === 0 ? (
            <p className="hint" role="status" style={{ marginBottom: 0 }}>
              {t('builder.grant.none')}
            </p>
          ) : null}
          <div className="row" style={{ justifyContent: 'space-between', marginTop: 18 }}>
            <button className="btn ghost sm" onClick={() => go('define')}>{t('builder.nav.backDefine')}</button>
            <button className="btn" onClick={() => go('design')}>{t('builder.nav.toDesign')}</button>
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
          <h2 className="sb-section-title" style={{ marginTop: 0 }}>{t('builder.build.title')}</h2>
          <p className="hint" style={{ marginTop: 0 }}>
            {t('builder.build.intro')}
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
            <button className="btn ghost sm" onClick={() => go('design')}>{t('builder.nav.backDesign')}</button>
            <button className="btn" onClick={next} disabled={!ctx.builtOk} title={ctx.builtOk ? t('builder.nav.toRunTitle') : t('builder.nav.buildFirst')}>{t('builder.nav.toRun')}</button>
          </div>
        </div>
      ) : null}

      {phase === 'run' ? (
        <div className="sb-run">
          {assistant}
          <h2 className="sb-section-title" style={{ marginTop: 0 }}>{t('builder.run.title')}</h2>
          <p className="hint" style={{ marginTop: 0 }}>
            {t('builder.run.intro')}
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
            <button className="btn ghost sm" onClick={() => go('build')}>{t('builder.nav.backBuild')}</button>
            <button className="btn" onClick={next} disabled={!hasRun} title={hasRun ? t('builder.nav.toEvaluateTitle') : t('builder.nav.runFirst')}>{t('builder.nav.toEvaluate')}</button>
          </div>
        </div>
      ) : null}

      {phase === 'evaluate' ? (
        <div className="sb-run">
          {assistant}
          <h2 className="sb-section-title" style={{ marginTop: 0 }}>{t('builder.evaluate.title')}</h2>
          <p className="hint" style={{ marginTop: 0 }}>
            {t('builder.evaluate.intro')}
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
          <button className="btn ghost sm" style={{ marginTop: 14 }} onClick={() => go('run')}>{t('builder.nav.backRun')}</button>
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
  const t = useTranslations('agents');
  const triggerKind = system.schedule?.kind ?? 'manual';
  const triggerWord = t(`builder.trigger.kinds.${triggerKind === 'cron' ? 'cron' : triggerKind === 'event' ? 'event' : 'manual'}.label`);

  return (
    <div className="simple-builder sb-view">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', gap: 12, marginBottom: 8 }}>
        <div>
          <h2 className="sb-section-title" style={{ marginTop: 0, marginBottom: 2 }}>{t('builder.view.title')}</h2>
          <p className="hint" style={{ marginTop: 0 }}>
            {t('builder.view.intro')}
          </p>
        </div>
        {canEdit && onEdit ? (
          <button className="btn ghost sm" onClick={onEdit} title={t('builder.view.editTitle')}>{t('builder.view.edit')}</button>
        ) : null}
      </div>

      {/* Trigger / Run + Monitor — the Run panel: a prominent ▶ Run, live progress, results.
          For a scheduled / called-from-system team the trigger is shown; the run control
          stays available (a manual run of a scheduled team is a normal, useful action). */}
      <div className="sb-run" style={{ marginBottom: 8 }}>
        <div className="row" style={{ alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span className="badge">{triggerWord}</span>
          {triggerKind === 'cron' && system.schedule?.cron ? (
            <span className="hint" style={{ marginTop: 0 }}>{t.rich('builder.view.scheduled', { cron: system.schedule.cron, mono: (c) => <span className="mono">{c}</span> })}</span>
          ) : triggerKind === 'event' ? (
            <span className="hint" style={{ marginTop: 0 }}>{t('builder.view.onCall')}</span>
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
        <h2 className="sb-section-title" style={{ marginTop: 0 }}>{t('builder.view.results')}</h2>
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
  onOutputDraftState,
  lastOutputs,
}: {
  systemId: string;
  system: System;
  canEdit: boolean;
  onCommit: (next: System) => void;
  onReload: () => void | Promise<void>;
  onNext: () => void;
  /** What the last run did with each declared output (shown at the output's row). */
  lastOutputs?: OutputResult[];
  /** Report the output section's draft state up to the builder, which owns every exit. */
  onOutputDraftState?: (state: OutputDraftState) => void;
}) {
  const t = useTranslations('agents');
  // 'Untitled system' is the stored placeholder name (lib/stages.ts), compared, never shown.
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
        <label className="sb-field-label" htmlFor="sb-name">{t('builder.define.nameLabel')}</label>
        <input
          id="sb-name"
          type="text"
          value={name}
          disabled={!canEdit}
          onChange={(e) => setName(e.target.value)}
          onBlur={saveName}
          onKeyDown={(e) => { if (e.key === 'Enter') saveName(); }}
          placeholder={t('builder.define.namePlaceholder')}
        />
      </div>

      {/* The deliverable box — plain words, no scaffold. It grounds Design + Evaluate. */}
      <div className="sb-hero">
        <h2 className="sb-hero-title">{t('builder.define.deliverableTitle')}</h2>
        <p className="sb-hero-sub">
          {t('builder.define.deliverableSub')}
        </p>
        <textarea
          className="sb-hero-input"
          rows={3}
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          onBlur={saveDesc}
          disabled={!canEdit}
          placeholder={t('builder.define.deliverablePlaceholder')}
        />
        <p className="hint" style={{ marginTop: 8 }}>{t('builder.define.successHint')}</p>
      </div>

      {/* Where the results go — declared outputs (auto-provisioned Write targets) */}
      <OutputsSection
        systemId={systemId}
        system={system}
        canEdit={canEdit}
        onCommit={onCommit}
        onDraftState={onOutputDraftState}
        lastOutputs={lastOutputs}
      />

      {/* How the team is triggered — Manual / On schedule / Called from system. Part of
          DEFINING the team, so it lives here (not next to Run). Same /schedule route. */}
      <TriggerMode systemId={systemId} system={system} canEdit={canEdit} onReload={onReload} />

      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
        <button className="btn" onClick={() => { saveName(); onNext(); }} disabled={!name.trim()}>{t('builder.nav.toGrant')}</button>
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
  const t = useTranslations('agents');
  const [picking, setPicking] = useState(false);
  // The agent open in the large editor (card Edit button / double-click).
  const [large, setLarge] = useState<string | null>(null);

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
          <h2 className="sb-section-title">{t('builder.design.title')}</h2>
          <p className="hint" style={{ marginTop: 0 }}>
            {t.rich('builder.design.intro', { strong: (c) => <strong>{c}</strong> })}
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
        <div className="sb-empty">{t('builder.design.empty')}</div>
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
              onOpen={() => setLarge(a.id)}
            />
          ))}
        </div>
      )}

      {large ? (
        <AgentEditorDialog
          systemId={systemId}
          system={system}
          agentId={large}
          canEdit={canEdit}
          isEntrypoint={large === system.entrypoint}
          onSetEntrypoint={canEdit ? () => onCommit(setEntrypoint(system, large)) : undefined}
          onChanged={onReload}
          onClose={() => setLarge(null)}
        />
      ) : null}

      {picking ? (
        <AgentTemplatePicker
          systemId={systemId}
          onPickTemplate={addTemplate}
          onPickMarketplace={addMarketplace}
          onCancel={() => setPicking(false)}
        />
      ) : (
        <button className="btn ghost sm sb-add" disabled={!canEdit} onClick={() => setPicking(true)}>
          {t('builder.design.addAgent')}
        </button>
      )}

      <div className="row" style={{ justifyContent: 'space-between', marginTop: 18 }}>
        <button className="btn ghost sm" onClick={onBack}>{t('builder.nav.backGrant')}</button>
        <button className="btn" onClick={onNext} disabled={!ready} title={ready ? t('builder.nav.toBuildTitle') : t('builder.nav.agentFirst')}>
          {t('builder.nav.toBuild')}
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
  const t = useTranslations('agents');
  const tc = useTranslations('common');
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
        <span className="hint" style={{ marginTop: 0 }}>{t('builder.propose.busy')}</span>
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
          <h3 style={{ margin: 0 }}>{t('builder.propose.title')}</h3>
          <p className="hint" style={{ marginTop: 2 }}>
            {t('builder.propose.intro')}
          </p>
        </div>
      </div>
      <ol className="sb-propose-list" style={{ margin: '10px 0', paddingLeft: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {rows.map((r, i) => (
          <li key={r.id} className="sb-card" style={{ padding: '10px 12px' }}>
            <div className="row" style={{ alignItems: 'center', gap: 8 }}>
              <span className="sb-card-order">{i + 1}</span>
              <span style={{ fontWeight: 650 }}>{r.role || r.id}</span>
              {i === 0 ? <span className="badge warn">{t('builder.start')}</span> : null}
              {canEdit ? (
                <button className="sb-chip-x" title={t('builder.propose.removeTitle')} style={{ marginLeft: 'auto' }} onClick={() => remove(r.id)}>✕</button>
              ) : null}
            </div>
            {r.instruction ? <p className="hint" style={{ margin: '4px 0 0' }}>{r.instruction}</p> : null}
          </li>
        ))}
      </ol>
      <div className="row" style={{ gap: 8 }}>
        <button className="btn" onClick={accept} disabled={!canEdit || rows.length === 0}>{t('builder.propose.use')}</button>
        <button className="btn ghost sm" onClick={() => setDismissed(true)}>{tc('actions.dismiss')}</button>
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
  const t = useTranslations('agents');
  const tc = useTranslations('common');
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
      if (!res.ok) throw new Error(body.error ?? t('builder.picker.loadFailed'));
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
        <span className="sb-field-label" style={{ margin: 0 }}>{t('builder.picker.title')}</span>
        <button className="btn ghost sm" onClick={onCancel}>{tc('actions.cancel')}</button>
      </div>
      <div className="tmpl-grid">
        {AGENT_TEMPLATES.map((tpl) => {
          const k = templateKeys(tpl.key);
          return (
            <button key={tpl.key} type="button" className="tmpl-card" onClick={() => onPickTemplate(tpl.key)}>
              <span className="tmpl-label">{k ? tk(t, { key: k.label }) : tpl.label}</span>
              <span className="tmpl-blurb">{k ? tk(t, { key: k.blurb }) : tpl.blurb}</span>
            </button>
          );
        })}
      </div>

      <div style={{ marginTop: 12 }}>
        {!expanded ? (
          <button className="btn ghost sm" onClick={loadMarketplace} disabled={loading}>
            {loading ? <span className="spin" /> : t('builder.picker.marketplace')}
          </button>
        ) : (
          <>
            <span className="sb-field-label" style={{ margin: '0 0 6px' }}>{t('builder.picker.fromShared')}</span>
            {loadErr ? <div className="error" style={{ marginBottom: 6 }}>{loadErr}</div> : null}
            {market && market.length > 0 ? (
              <div className="tmpl-grid">
                {market.map((a, i) => (
                  <button key={`${a.source}-${i}`} type="button" className="tmpl-card" title={a.source} onClick={() => onPickMarketplace(a)}>
                    <span className="tmpl-label">{a.role}</span>
                    <span className="tmpl-blurb">{t('builder.picker.from', { source: a.source })}</span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="hint" style={{ marginTop: 0 }}>{t('builder.picker.none')}</p>
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
  onOpen,
}: {
  system: System;
  agentId: string;
  index: number;
  count: number;
  canEdit: boolean;
  catalog: string[] | null;
  onCommit: (next: System) => void;
  /** Open this agent in the large editor. */
  onOpen: () => void;
}) {
  const agent = system.agents.find((a) => a.id === agentId)!;
  const t = useTranslations('agents');
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
    <div
      className={`sb-card${isStart ? ' start' : ''}`}
      // Double-click the card (not inside a field or button) opens the large editor.
      onDoubleClick={(e) => {
        if ((e.target as Element).closest('input, textarea, select, button, a, label, [contenteditable]')) return;
        onOpen();
      }}
    >
      <div className="sb-card-head">
        <span className="sb-card-order">{index + 1}</span>
        {isStart ? (
          <span className="badge warn">{t('builder.start')}</span>
        ) : canEdit ? (
          <button className="btn ghost sm" onClick={() => onCommit(setEntrypoint(system, agentId))} title={t('builder.card.makeStartTitle')}>{t('builder.card.makeStart')}</button>
        ) : null}
        <div className="sb-card-tools" style={{ marginLeft: 'auto' }}>
          <button
            className="btn ghost sm"
            onClick={onOpen}
            aria-label={t('builder.card.editAria', { id: agentId })}
            title={t('builder.card.editTitle')}
          >
            {t('builder.card.edit')}
          </button>
          {canEdit ? (
            <>
              <button className="icon-btn" disabled={index === 0} title={t('builder.card.moveUp')} onClick={() => onCommit(moveAgent(system, agentId, -1))}>↑</button>
              <button className="icon-btn" disabled={index === count - 1} title={t('builder.card.moveDown')} onClick={() => onCommit(moveAgent(system, agentId, 1))}>↓</button>
              <button className="icon-btn danger" title={t('builder.card.remove')} onClick={() => onCommit(removeAgentSimple(system, agentId))}>✕</button>
            </>
          ) : null}
        </div>
      </div>

      <label className="sb-field-label" htmlFor={`role-${agentId}`}>{t('builder.card.roleLabel')}</label>
      <input
        id={`role-${agentId}`}
        type="text"
        value={role}
        disabled={!canEdit}
        onChange={(e) => setRole(e.target.value)}
        onBlur={saveRole}
        placeholder={t('builder.card.rolePlaceholder')}
      />

      <label className="sb-field-label" htmlFor={`instr-${agentId}`} style={{ marginTop: 10 }}>{t('builder.card.instructionsLabel')}</label>
      <textarea
        id={`instr-${agentId}`}
        rows={5}
        value={instr}
        disabled={!canEdit}
        onChange={(e) => setInstr(e.target.value)}
        onBlur={saveInstr}
        placeholder={t('builder.card.instructionsPlaceholder')}
      />

      <div className="sb-card-meta">
        <div className="sb-model">
          <span className="sb-field-label" style={{ margin: 0 }}>{t('builder.card.model')}</span>
          <span className="badge">{t('builder.card.modelAuto')}</span>
          <span className="hint" style={{ marginTop: 0 }}>
            {/* auto.reason comes from lib/routing.ts (shared with the server) and stays English for now. */}
            {t('builder.card.modelNeed', { need: auto.need, reason: auto.reason })}
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
  const t = useTranslations('agents');
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

  // Persist a new selection. Everything on offer selected ⇒ NO list: the agent keeps using
  // everything the team is granted (so applying the picker unchanged never limits an agent).
  // Anything less ⇒ the narrowed list: each selected capability resolves to its kind's
  // read ∪ granted-write tools ∩ the team pool (never wider than `grants.tools`).
  const persist = (nextIds: string[]) => {
    if (!canEdit) return;
    const tools = toolsForSelection(offeredIds, nextIds, (ids) => toolsForCapabilityChipsInPool(ids, system.grants.tools));
    onCommit({ ...system, agents: system.agents.map((a) => {
      if (a.id !== agentId) return a;
      if (tools !== undefined) return { ...a, tools };
      const { tools: _own, ...inheriting } = a;
      void _own;
      return inheriting;
    }) });
  };

  // Is this agent using everything the team is granted, or its own list — and has the team
  // been granted something that list lacks? Said on the card, with the one-click repairs.
  const capState = agentCapabilityState(system, agentId);
  const staleMsg = staleLimitMessage(capState, (l) => capLabelText(t, l));
  const staleNote = staleMsg ? tk(t, staleMsg) : null;

  const removeCap = (id: string) => persist(selectedIds.filter((s) => s !== id));

  return (
    <div className="sb-tools">
      <div className="row" style={{ alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <span className="sb-field-label" style={{ margin: 0 }}>{t('builder.capabilities.title')}</span>
        {canEdit && offeredChips.length > 0 ? (
          <button type="button" className="btn ghost sm" onClick={() => setPickerOpen(true)}>
            {t('builder.capabilities.add')}
          </button>
        ) : null}
      </div>

      <p className="hint" role="status" style={{ marginTop: 0, marginBottom: 6 }}>
        {tk(t, capabilityStateMessage(capState, selectedIds.length))}
        {capState.mode === 'limited' && canEdit ? (
          <button
            type="button"
            className="btn ghost sm"
            style={{ marginLeft: 8 }}
            title={t('builder.capabilities.useEverythingTitle')}
            onClick={() => onCommit(useEverything(system, agentId))}
          >
            {t('builder.capabilities.useEverything')}
          </button>
        ) : null}
      </p>
      {staleNote && capState.mode === 'limited' ? (
        <p className="hint" role="note" style={{ marginTop: 0, marginBottom: 6, color: 'var(--warn, #b7791f)' }}>
          {staleNote}
          {canEdit ? capState.missingLabels.map((label) => (
            <button
              key={label}
              type="button"
              className="btn ghost sm"
              style={{ marginLeft: 8 }}
              onClick={() => onCommit(addMissingCapability(system, agentId, label))}
            >
              {t('builder.capabilities.addMissing', { label: capLabelText(t, label) })}
            </button>
          )) : null}
        </p>
      ) : null}

      {/* WRITING is not a capability to pick here: it comes from the outputs declared on Define,
          and the tool is handed to this agent at run time. Say which it has — or how to get one —
          instead of leaving the author to look for a tool this picker never lists. */}
      {agentOutputTools(system, agentId).length > 0 ? (
        <p className="hint" style={{ marginTop: 0, marginBottom: 6 }}>
          {t.rich('builder.capabilities.mayWrite', { tools: agentOutputTools(system, agentId).join(', '), mono: (c) => <span className="mono">{c}</span> })}
        </p>
      ) : (
        <p className="hint" style={{ marginTop: 0, marginBottom: 6 }}>
          {t('builder.capabilities.cannotSave')}
        </p>
      )}

      {offeredChips.length === 0 ? (
        <p className="hint" style={{ marginTop: 0, marginBottom: 0 }}>
          {t('builder.capabilities.noneAvailable')}
        </p>
      ) : selectedIds.length === 0 ? (
        <p className="hint" style={{ marginTop: 0, marginBottom: 0 }}>
          {t('builder.capabilities.noneSelected')}
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
                    title={t('builder.capabilities.showTitle')}
                  >
                    <span className="badge muted" style={{ marginRight: 6 }}>{domainText(t, chip.domain)}</span>
                    {chipText(t, chip, 'label')}
                    <span className="sb-cap-caret" aria-hidden>{open ? '▾' : '▸'}</span>
                  </button>
                  {canEdit ? (
                    <button className="sb-chip-x" title={t('builder.capabilities.removeTitle')} onClick={() => removeCap(id)}>✕</button>
                  ) : null}
                </div>
                {open ? <p className="sb-cap-desc hint" style={{ margin: '4px 0 0' }}>{chipText(t, chip, 'description')}</p> : null}
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
  const t = useTranslations('agents');
  const tc = useTranslations('common');
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
      <div className="sb-cap-modal" role="dialog" aria-label={t('builder.capabilities.pickerTitle')} onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>{t('builder.capabilities.pickerTitle')}</h3>
          <button className="btn ghost sm" onClick={onClose}>{tc('actions.cancel')}</button>
        </div>
        <p className="hint" style={{ marginTop: 0 }}>
          {t('builder.capabilities.pickerHint')}
        </p>
        <div className="sb-cap-groups">
          {groups.map(([domain, chips]) => (
            <div key={domain} className="sb-cap-group">
              <div className="sb-field-label" style={{ margin: '2px 0 4px' }}>{domainText(t, domain)}</div>
              {chips.map((c) => {
                const on = picked.has(c.id);
                return (
                  <label key={c.id} className={`sb-cap-option${on ? ' on' : ''}`}>
                    <input type="checkbox" checked={on} onChange={() => toggle(c.id)} style={{ accentColor: 'var(--gold-deep)' }} />
                    <span className="sb-cap-option-body">
                      <span className="sb-cap-option-name">{chipText(t, c, 'label')}</span>
                      <span className="sb-cap-option-desc">{chipText(t, c, 'description')}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          ))}
        </div>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button className="btn" onClick={() => onApply([...picked])}>{t('builder.capabilities.apply')}</button>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────── Trigger mode (Define) ─────────────────────────── */

type TriggerKind = 'manual' | 'cron' | 'event';
// Label + blurb are `builder.trigger.kinds.<kind>.label|blurb` in the catalog.
const TRIGGER_CARDS: TriggerKind[] = ['manual', 'cron', 'event'];

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
  const t = useTranslations('agents');
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
      if (!res.ok) throw new Error(b.error ?? t('builder.trigger.updateFailed'));
      if (b.cron && next.kind === 'cron') {
        // scheduleSavedNote (lib/schedule-note.ts) is shared with SystemView and stays English for now.
        setNote(scheduleSavedNote(b.cron, b.autonomousEnabled === true));
      }
      toast.success(t('builder.trigger.set', { kind: next.kind }));
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
      <h2 className="sb-section-title" style={{ marginTop: 0 }}>{t('builder.trigger.title')}</h2>
      <div className="tmpl-grid" role="group" aria-label={t('builder.trigger.aria')}>
        {TRIGGER_CARDS.map((c) => (
          <button
            key={c}
            type="button"
            className={`tmpl-card${kind === c ? ' active' : ''}`}
            aria-pressed={kind === c}
            disabled={!canEdit || busy}
            onClick={() => canEdit && kind !== c && pick(c)}
          >
            <span className="tmpl-label">{t(`builder.trigger.kinds.${c}.label`)}</span>
            <span className="tmpl-blurb">{t(`builder.trigger.kinds.${c}.blurb`)}</span>
          </button>
        ))}
      </div>

      {kind === 'cron' ? (
        <div style={{ marginTop: 10 }}>
          <label className="sb-field-label">{t('builder.trigger.when')}</label>
          <RecurrenceEditor
            cron={cron}
            disabled={!canEdit || busy}
            onChange={(next) => { setCron(next); void save({ kind: 'cron', cron: next }); }}
          />
        </div>
      ) : null}

      {kind === 'event' ? (
        <div style={{ marginTop: 10 }} className="hint">
          {t.rich('builder.trigger.eventHint', {
            tool: 'run_agent_system',
            endpoint: `POST /api/agents/systems/${systemId}/run`,
            mono: (c) => <span className="mono">{c}</span>,
          })}
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
  const t = useTranslations('agents');
  const f = useFormat();
  const { user } = useUser();
  const [judge, setJudge] = useState<JudgeResult | null>(null);
  const [judging, setJudging] = useState(false);
  const [judgeErr, setJudgeErr] = useState('');
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfErr, setPdfErr] = useState('');

  const checks = useMemo(() => (lastRun ? runChecks(lastRunToDiag(lastRun)) : []), [lastRun]);
  const output = lastRun?.output ?? '';
  // The list a "Save now" just answered with — shown until the next run replaces it.
  const [savedOutputs, setSavedOutputs] = useState<OutputResult[] | null>(null);
  useEffect(() => { setSavedOutputs(null); }, [lastRun?.runId, lastRun?.at]);

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
      setPdfErr(t('builder.evaluate.pdfFailed', { error: (e as Error).message }));
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
      if (!res.ok) throw new Error(body.error ?? t('builder.evaluate.judgeFailed'));
      setJudge(body as JudgeResult);
    } catch (e) {
      setJudgeErr((e as Error).message);
    } finally {
      setJudging(false);
    }
  };

  if (!lastRun) {
    return <div className="sb-empty">{t('builder.evaluate.noRun')}</div>;
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
          title={t('builder.evaluate.pdfTitle')}
        >
          {pdfBusy ? <span className="spin" /> : t('builder.evaluate.pdf')}
        </button>
      </div>
      {pdfErr ? <div className="error" style={{ marginBottom: 8 }}>{pdfErr}</div> : null}

      {/* Where the run's results went (Define → "Where the results go") — and save again. */}
      <RunOutputs
        systemId={systemId}
        outputs={savedOutputs ?? lastRun.outputs}
        declared={system.outputs}
        canSave={canEdit}
        onSaved={setSavedOutputs}
      />

      {/* Deterministic checks — green/red, zero-cost, no model. */}
      <div className="row" style={{ alignItems: 'center', gap: 8 }}>
        <h2 className="sb-section-title" style={{ margin: 0 }}>{t('builder.evaluate.checks')}</h2>
        <span className={`badge ${allChecksPass(checks) ? 'ok' : 'warn'}`}>
          {allChecksPass(checks) ? t('builder.evaluate.allPassed') : t('builder.evaluate.toLookAt', { count: checks.filter((c) => !c.pass).length })}
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
        {checks.map((c) => (
          <div key={c.id} className="row" style={{ alignItems: 'baseline', gap: 8 }}>
            <span className={`badge ${c.pass ? 'ok' : 'err'}`} style={{ minWidth: 22, textAlign: 'center' }}>{c.pass ? '✓' : '✗'}</span>
            <span style={{ fontWeight: 600, minWidth: 160 }}>{tk(t, { key: c.labelKey })}</span>
            <span className="hint" style={{ marginTop: 0 }}>{tk(t, c.detailMsg)}</span>
          </div>
        ))}
      </div>

      {/* LLM-judge — one click, scores against the system's task Description.
          Marked EXPERIMENTAL: LLM-as-judge scoring is indicative, not authoritative. */}
      <div className="row" style={{ alignItems: 'center', gap: 8, marginTop: 18 }}>
        <h2 className="sb-section-title" style={{ margin: 0 }}>{t('builder.evaluate.judge')}</h2>
        <span className="badge warn" title={t('builder.evaluate.experimentalTitle')}>{t('builder.evaluate.experimental')}</span>
        <button className="btn primary" onClick={runJudge} disabled={judging || !canEdit || !output.trim()} title={output.trim() ? t('builder.evaluate.judgeTitle') : t('builder.evaluate.noOutput')}>
          {judging ? <span className="spin" /> : judge ? t('builder.evaluate.rejudge') : t('builder.evaluate.judgeRun')}
        </button>
      </div>
      <p className="hint" style={{ marginTop: 4 }}>
        {t('builder.evaluate.judgeIntro')}
        <br />
        {t.rich('builder.evaluate.judgeCaveat', { strong: (c) => <strong>{c}</strong> })}
      </p>
      {judgeErr ? <div className="error" style={{ marginTop: 6 }}>{judgeErr}</div> : null}
      {judge ? (
        <div style={{ marginTop: 8 }}>
          <div className="row" style={{ alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span className="badge ok" style={{ fontSize: 13 }}>{t('builder.evaluate.overall', { score: f.number(judge.overall) })}</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {judge.scores.map((s) => (
              <div key={s.dimension} className="sb-card" style={{ padding: '10px 12px' }}>
                <div className="row" style={{ alignItems: 'center', gap: 8 }}>
                  <span style={{ fontWeight: 650 }}>{dimensionKey(s.dimension) ? tk(t, { key: dimensionKey(s.dimension)! }) : dimensionLabel(s.dimension)}</span>
                  <span className="badge">{t('builder.evaluate.score', { score: f.number(s.score) })}</span>
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

/**
 * What the output section reports up so the builder can guard the stage exit: whether there
 * is unsaved typing, whether it may be committed as it stands, and the two actions.
 * `save`/`discard` are re-registered on every draft change, so they always act on the
 * CURRENT draft (a stale closure would save text the author has since changed).
 */
type OutputDraftState = {
  dirty: boolean;
  valid: boolean;
  save: () => void;
  discard: () => void;
};
const EMPTY_OUTPUT_DRAFT_STATE: OutputDraftState = {
  dirty: false, valid: false, save: () => {}, discard: () => {},
};

/** A DLS-scoped folder row from the grants-available feed (path + scope). */
type FolderNode = { path: string; scope: 'personal' | 'domain' };

/** The three destination kinds a declared output can target, with plain labels. */
// Each label is `builder.outputs.kinds.<kind>` in the catalog.
const OUTPUT_KIND_CARDS: { kind: OutputKind; feedKind: 'files' | 'data' | 'knowledge' }[] = [
  { kind: 'files', feedKind: 'files' },
  { kind: 'data', feedKind: 'data' },
  { kind: 'knowledge', feedKind: 'knowledge' },
];

/**
 * "Where the results go" — DECLARED OUTPUTS. Each row picks a destination Type
 * (File · Dataset · Knowledge), a Name, a Folder (existing or ＋ New folder) and a
 * Scope (My / Domain). Declaring an output auto-grants the team **Write** to that
 * folder (reusing the grant/write-tool machinery — see `addOutput`); the folder
 * materialises when the first result is saved. Consistent with the grants picker.
 */
function OutputsSection({
  systemId, system, canEdit, onCommit, onDraftState, lastOutputs,
}: {
  /** What the LAST run did with each declared output — shown at its row. */
  lastOutputs?: OutputResult[];
  systemId: string;
  system: System;
  canEdit: boolean;
  onCommit: (next: System) => void;
  /** Report `{ dirty, valid, save, discard }` up — the builder owns the exit guard. */
  onDraftState?: (state: OutputDraftState) => void;
}) {
  // Folders per kind, from the DLS-scoped grants-available feed (one fetch per kind).
  const t = useTranslations('agents');
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

  // The draft row (Type/Name/Scope/Folder) — ONE object, so dirtiness and validity are
  // decided by the shared predicates rather than by four ad-hoc comparisons.
  const [draft, setDraft] = useState<OutputDraft>(EMPTY_OUTPUT_DRAFT);
  const patch = (next: Partial<OutputDraft>) => setDraft((d) => ({ ...d, ...next }));

  // PARK the draft per system. The stage guard covers the exits the builder owns; it cannot
  // cover leaving the system (the sidebar, another tab, a reload), which unmounts this section
  // with no transition to intercept — the "it reset" the owner reported. So the draft is
  // written to session storage on every change and read back on mount. `sessionStorage` is
  // absent on the server and THROWS in a private window, so every access is guarded and a
  // failure simply means no parking, never a broken section.
  // The "have I read this slot yet" marker is the KEY, not a boolean: the same mounted section
  // can be handed another system (the builder is reused), and a boolean would then leave the
  // previous system's draft on screen AND park it under the new system's key.
  const parkKey = outputDraftStorageKey(systemId);
  const restoredFor = useRef<string | null>(null);
  useEffect(() => {
    if (restoredFor.current === parkKey) return;
    restoredFor.current = parkKey;
    let parked: OutputDraft | null = null;
    try {
      parked = parseOutputDraft(window.sessionStorage.getItem(parkKey));
    } catch { /* no session storage (private window) — nothing to restore */ }
    // Reset to empty when the new system has nothing parked, so the old system's typing
    // cannot follow the author into another team.
    setDraft(parked ?? EMPTY_OUTPUT_DRAFT);
  }, [parkKey]);
  useEffect(() => {
    if (restoredFor.current !== parkKey) return; // never park over a slot before reading it
    try {
      if (outputDraftDirty(draft)) window.sessionStorage.setItem(parkKey, serializeOutputDraft(draft));
      else window.sessionStorage.removeItem(parkKey);
    } catch { /* storage unavailable — the in-memory draft still works for this mount */ }
  }, [draft, parkKey]);

  const foldersFor = (kind: OutputKind, scope: 'personal' | 'domain'): string[] =>
    (foldersByKind[kind] ?? []).filter((f) => f.scope === scope).map((f) => f.path);

  const dirty = canEdit && outputDraftDirty(draft);
  const valid = outputDraftValid(draft);

  // Save the draft as a declared output. UNCHANGED governance: `addOutput` → `onCommit` →
  // the governed system.yaml write, exactly as the old add-output button did (the label changed,
  // the path did not).
  // NOTE: the old label is deliberately not quoted anywhere in this file — output-draft.test.ts
  // greps for it.
  const saveRow = useCallback(() => {
    if (!canEdit || !outputDraftValid(draft)) return;
    try { window.sessionStorage.removeItem(parkKey); } catch { /* nothing parked */ }
    onCommit(addOutput(system, {
      kind: draft.kind,
      name: draft.name.trim(),
      folder: { path: normaliseFolderPath(draft.folder), scope: draft.scope },
    }));
    setDraft(EMPTY_OUTPUT_DRAFT);
  }, [canEdit, draft, onCommit, system, parkKey]);

  // Re-register on every draft change, so the save the builder's guard holds reads the
  // CURRENT draft — a closure captured when dirtiness last flipped would save stale text.
  const discardRow = useCallback(() => {
    try { window.sessionStorage.removeItem(parkKey); } catch { /* nothing parked */ }
    setDraft(EMPTY_OUTPUT_DRAFT);
  }, [parkKey]);
  useEffect(() => {
    onDraftState?.({ dirty, valid, save: saveRow, discard: discardRow });
  }, [dirty, valid, saveRow, discardRow, onDraftState]);
  // On unmount, stop REPORTING a draft (a later stage must not guard a section that is gone) —
  // but the draft itself stays parked in session storage, so remounting restores it.
  useEffect(() => () => onDraftState?.(EMPTY_OUTPUT_DRAFT_STATE), [onDraftState]);

  const kindLabel = (k: OutputKind) => (OUTPUT_KIND_CARDS.some((c) => c.kind === k) ? t(`builder.outputs.kinds.${k}`) : k);

  return (
    <div className="sb-resources sb-outputs" style={{ marginTop: 16 }}>
      <h2 className="sb-section-title" style={{ marginTop: 0 }}>{t('builder.outputs.title')}</h2>
      <p className="hint" style={{ marginTop: 0 }}>
        {t('builder.outputs.intro')}
      </p>

      {outputs.length > 0 ? (
        <div className="sb-out-list">
          {outputs.map((o, i) => (
            <div key={`${o.kind}:${o.folder.scope}:${o.folder.path}:${o.name}:${i}`} className="sb-out-row" style={{ flexWrap: 'wrap' }}>
              <span className="badge muted">{kindLabel(o.kind)}</span>
              <span className="sb-out-name">{o.name}</span>
              <span className="sb-out-dest hint" style={{ marginTop: 0 }}>
                → 📁 {o.folder.path === '/' ? t('builder.outputs.root') : o.folder.path}
                <span className="badge muted" style={{ marginLeft: 6 }}>{o.folder.scope === 'domain' ? t('builder.outputs.scope.domain') : t('builder.outputs.scope.my')}</span>
              </span>
              {/* Who writes it. The writing tool goes to that agent automatically at run time —
                  choosing the target IS the permission; there is no tool to add by hand. */}
              {system.agents.length > 1 ? (
                <label className="hint" style={{ marginTop: 0, display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                  {t('builder.outputs.writtenBy')}
                  <select
                    value={o.agent && system.agents.some((a) => a.id === o.agent) ? o.agent : ''}
                    disabled={!canEdit}
                    onChange={(e) => onCommit(setOutputAgent(system, i, e.target.value || null))}
                  >
                    <option value="">{t('builder.outputs.anyAgent')}</option>
                    {system.agents.map((a) => <option key={a.id} value={a.id}>{a.id}</option>)}
                  </select>
                </label>
              ) : null}
              {canEdit ? (
                <button className="sb-chip-x" title={t('builder.outputs.removeTitle')} style={{ marginLeft: 'auto' }} onClick={() => onCommit(removeOutput(system, i))}>✕</button>
              ) : null}
              {/* What will happen when it is written — from the same hold rule the run applies. */}
              <span
                className="hint"
                role="note"
                style={{ flexBasis: '100%', marginTop: 2, color: outputLanding(system, o).mode === 'direct' ? undefined : 'var(--warn, #b7791f)' }}
              >
                {/* outputLanding / outputCaveats (lib/output-tools.ts) are shared with the run path: English for now. */}
                {outputLanding(system, o).text}
              </span>
              {/* What this output cannot do — said here, before a run finds out. */}
              {outputCaveats(system, o).map((c) => (
                <span key={c} className="hint" role="note" style={{ flexBasis: '100%', marginTop: 0 }}>{c}</span>
              ))}
              {/* Where the last run put it. */}
              {(() => {
                const last = lastOutputs?.find((r) => r.key === outputKey(o));
                if (!last) return null;
                return (
                  <span className="hint" style={{ flexBasis: '100%', marginTop: 0, color: last.state === 'saved' ? undefined : 'var(--warn, #b7791f)' }}>
                    {/* last.message is the server's own text: shown verbatim. */}
                    {t('builder.outputs.lastRun', { message: last.message })}
                    {last.state === 'saved' && last.link ? <> · <a href={last.link} target="_blank" rel="noopener">{t('builder.outputs.open')}</a></> : null}
                  </span>
                );
              })()}
            </div>
          ))}
        </div>
      ) : (
        <p className="hint" style={{ marginTop: 0, marginBottom: 0 }}>{t('builder.outputs.none')}</p>
      )}

      {canEdit ? (
        <div className="sb-out-add">
          <div className="sb-out-add-fields">
            <label className="sb-field-label" style={{ margin: 0 }}>{t('builder.outputs.type')}</label>
            <select value={draft.kind} onChange={(e) => patch({ kind: e.target.value as OutputKind })}>
              {OUTPUT_KIND_CARDS.map((c) => <option key={c.kind} value={c.kind}>{kindLabel(c.kind)}</option>)}
            </select>

            <label className="sb-field-label" style={{ margin: 0 }}>{t('builder.outputs.name')}</label>
            <input
              type="text"
              value={draft.name}
              placeholder={draft.kind === 'data' ? t('builder.outputs.namePlaceholderData') : t('builder.outputs.namePlaceholder')}
              onChange={(e) => patch({ name: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); saveRow(); } }}
              style={{ minWidth: 180 }}
            />

            <label className="sb-field-label" style={{ margin: 0 }}>{t('builder.outputs.scopeLabel')}</label>
            <span className="sb-out-scope" role="radiogroup" aria-label={t('builder.outputs.scopeAria')} style={{ display: 'inline-flex', gap: 2 }}>
              {(['personal', 'domain'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={draft.scope === s}
                  className={`sb-access-seg-btn${draft.scope === s ? ' active' : ''}`}
                  onClick={() => { if (draft.scope !== s) patch({ scope: s, folder: '/' }); }}
                >
                  {s === 'domain' ? t('builder.outputs.scope.domain') : t('builder.outputs.scope.my')}
                </button>
              ))}
            </span>

            <label className="sb-field-label" style={{ margin: 0 }}>{t('builder.outputs.folder')}</label>
            <NewFolderField
              folders={foldersFor(draft.kind, draft.scope)}
              value={draft.folder}
              scope={draft.scope}
              canEdit={canEdit}
              onChange={(folder) => patch({ folder })}
            />
          </div>
          {/* The draft is NOT on the system until it is saved — say so where the typing is,
              as soon as anything is typed. */}
          {dirty ? (
            <span
              className="badge warn"
              style={{ marginRight: 8 }}
              title={t('builder.outputs.unsavedTitle')}
            >
              {t('builder.outputs.unsaved')}
            </span>
          ) : null}
          <button type="button" className="btn ghost sm sb-out-addbtn" disabled={!valid} onClick={saveRow}>
            {t('builder.outputs.save')}
          </button>
        </div>
      ) : null}
    </div>
  );
}