/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import BuildRunPanel from './BuildRunPanel';
import RecurrenceEditor from './RecurrenceEditor';
import type { System, SafetyPreset, DataLayer } from '@/lib/agents/system-schema';
import { classifyModelNeed } from '@/lib/agents/routing';
import { instructionsOf } from '@/lib/agents/agent-md';
import {
  addSimpleAgent, moveAgent, removeAgentSimple,
  setAgentInstructions, setAgentRole, setArtifactGrant, removeArtifactGrant,
  setDescription, addSystemTool, setDataGrantLayer,
  setFolderGrant, removeFolderGrant, setArtifactGrantLevel, setFolderGrantLevel,
} from '@/lib/agents/simple-edit';
import {
  accessCap, allowedAccessLevels, capabilityToAccess, clampAccess,
  ACCESS_LABELS, type AccessLevel, type AccessCap,
} from '@/lib/agents/access-levels';
import { membersOf, isWorkflowId, type ResourceMember } from '@/lib/agents/resource-groups';
import { scopeLabel, type ScopeKey } from '@/lib/core/scopes';
import FolderTree, { type FolderSelection } from '@/components/core/FolderTree';
import { useToast } from '@/components/core/Toast';
import { itemsUnderFolder, normaliseFolderPath } from '@/lib/core/folders';
import {
  capabilityChipsForGrants, toolsForCapabilityChipsInPool, chipIdsForTools,
  type CapabilityChip,
} from '@/lib/agents/capability-tools';
import { setEntrypoint } from '@/lib/agents/canvas-edit';
import { AGENT_TEMPLATES, agentTemplate, type AgentTemplateKey } from '@/lib/agents/agent-templates';
import StageShell from '@/components/core/StageShell';
import {
  advance, goTo, initialStageState, isSatisfied, markDone,
  type StageDef, type StageState,
} from '@/lib/core/stages';
import { runChecks, allChecksPass } from '@/lib/agents/build/run-checks';
import type { DiagRun } from '@/lib/agents/build/run-diagnostics';
import { dimensionLabel, type JudgeResult } from '@/lib/agents/evaluate-judge';
import { downloadEvalPdf } from '@/lib/agents/build/agent-pdf';
import { useUser } from '@/lib/useUser';

/**
 * Simple mode — the guided builder for non-coders, now a FIVE-phase path:
 *   Define · Design · Build · Run · Evaluate.
 * It reads and writes the SAME `system.yaml` / `agents/<id>/AGENT.md` Developer mode
 * does, through the SAME `commitSystem` file write and `/api/agents` endpoints. There
 * is NO parallel data model. Build/Run/Evaluate reuse the ONE `BuildRunPanel` run
 * engine (gated per phase); the schedule reuses the existing schedule route; the
 * LLM-judge reuses the ONE governed assistant model via the evaluate route.
 *
 *  1. Define    — Name, Description (the describe→scaffold box), safety preset + trigger mode.
 *  2. Design    — the team: per-agent cards + a template picker on "+ Add agent".
 *  3. Build     — compile + verify the team (no run).
 *  4. Run       — one-click ▶ Run + live progress + the final result.
 *  5. Evaluate  — per-agent breakdown + deterministic checks + LLM-judge + diagnostics/PDF/trace.
 *
 * The stepper rail + phase gating ride the OS-wide staged-builder primitive
 * (lib/core/stages.ts + components/core/StageShell.tsx) — this builder is its
 * reference adoption; the phase CONTENT below stays Agents-specific.
 */

type Phase = 'define' | 'design' | 'build' | 'run' | 'evaluate';

/** The live state the phase gates/✓-conditions read — derived fresh each render. */
type PhaseCtx = {
  named: boolean;
  ready: boolean;
  builtOk: boolean;
  hasRun: boolean;
  checksPass: boolean;
};

/**
 * The five phases as a shared-core staged path (lib/core/stages.ts + the StageShell
 * rail). `enabled` gates which phases are reachable — you can't Build/Run/Evaluate
 * without a team, and you can't Evaluate without a run. `completed` is each phase's
 * underlying condition; a phase shows a ✓ only when the user has ALSO completed it
 * this session (tracked in the StageState below), so a step never shows done on
 * first open, and a check clears if the user later invalidates it (e.g. deletes
 * every agent). Build/Run/Evaluate reflect their live server state.
 */
const PHASES: StageDef<Phase, PhaseCtx>[] = [
  { id: 'define', title: 'Define', completed: (c) => c.named },
  { id: 'design', title: 'Design', completed: (c) => c.ready },
  { id: 'build', title: 'Build', enabled: (c) => c.ready, completed: (c) => c.builtOk }, // a green ✓ once the team is built
  { id: 'run', title: 'Run', enabled: (c) => c.ready, completed: (c) => c.hasRun },
  // Evaluate is ✓ once a run's deterministic checks all pass (the "✓ all passed" state).
  { id: 'evaluate', title: 'Evaluate', enabled: (c) => c.ready && c.hasRun, completed: (c) => c.checksPass },
];

type BuildRunProps = {
  running: boolean;
  lastBuild: React.ComponentProps<typeof BuildRunPanel>['lastBuild'];
  activity: React.ComponentProps<typeof BuildRunPanel>['activity'];
  lastRun: React.ComponentProps<typeof BuildRunPanel>['lastRun'];
  nodePath: string[];
};

export default function SimpleBuilder({
  systemId,
  system,
  canEdit,
  catalog,
  buildRun,
  onCommit,
  onReload,
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
}) {
  // Always OPEN on Define — creating a new system OR opening an existing one lands
  // here, never jumping ahead. Phase checkmarks reflect what the user has actually
  // completed THIS session (`stage.done`), so a freshly opened system shows NO green
  // checks even if its persisted state happens to satisfy a phase's condition. Both
  // rules are guaranteed by the shared stage model (lib/core/stages.ts).
  const [stage, setStage] = useState<StageState<Phase>>(() => initialStageState(PHASES));
  const phase = stage.current;
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
  const ctx: PhaseCtx = {
    named: !!system.system.name && system.system.name !== 'Untitled system',
    ready,
    builtOk: !!buildRun.lastBuild?.ok,
    hasRun,
    checksPass: hasRun && allChecksPass(runChecks(lastRunToDiag(buildRun.lastRun!))),
  };

  // Every transition goes through the shared stage model: `go` jumps (entry-gated),
  // `next` advances and records the current phase's ✓ only when its condition is met
  // — the same "mark if done, then move" behavior the builder always had.
  const go = (id: Phase) => setStage((s) => goTo(PHASES, s, id, ctx));
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
        <DefineStep
          systemId={systemId}
          system={system}
          canEdit={editable}
          onScaffolded={async () => { await onReload(); setStage((s) => goTo(PHASES, markDone(s, 'define'), 'design', ctx)); }}
          onReload={onReload}
          onCommit={(next) => commit(next)}
          onNext={next}
        />
      ) : null}

      {phase === 'design' ? (
        <DesignStep
          systemId={systemId}
          system={system}
          canEdit={editable}
          catalog={catalog}
          onCommit={commit}
          onBack={() => go('define')}
          onNext={next}
          ready={ready}
        />
      ) : null}

      {phase === 'build' ? (
        <div className="sb-run">
          <h2 className="sb-section-title" style={{ marginTop: 0 }}>Build</h2>
          <p className="hint" style={{ marginTop: 0 }}>
            Compile your team and verify it — the same build developers run. Nothing runs yet.
            When it is green, move on to Run.
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
            <button className="btn" onClick={next}>Run →</button>
          </div>
        </div>
      ) : null}

      {phase === 'run' ? (
        <div className="sb-run">
          <h2 className="sb-section-title" style={{ marginTop: 0 }}>Run</h2>
          <p className="hint" style={{ marginTop: 0 }}>
            Run the team — it walks from the START agent and shows its progress and final result.
            How it is triggered is set on Define. See the step-by-step breakdown under Evaluate.
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

/* ─────────────────────────── Phase 1 — Define ─────────────────────────── */

const PRESETS: { id: SafetyPreset; label: string; consequence: string }[] = [
  { id: 'read-only',      label: 'Read-only',             consequence: 'The team can look but never change anything.' },
  { id: 'read-propose',   label: 'Read + propose',        consequence: 'The team suggests changes — a human approves each one before it runs.' },
  { id: 'read-bounded',   label: 'Read + bounded writes', consequence: 'The team can write inside its own workspace, nowhere else.' },
  { id: 'full-in-scope',  label: 'Full in-scope',         consequence: 'The team may write anywhere its grants allow — use with care.' },
];

/**
 * Phase 1 — Define. Name on top, Description below it (the describe→scaffold box that
 * edits system.yaml server-side), then the safety/rights preset — surfaced HERE on
 * the first page. Success criteria live in the Description prose or in a granted
 * Knowledge workflow; there is deliberately NO separate acceptance-criteria field.
 */
function DefineStep({
  systemId,
  system,
  canEdit,
  onScaffolded,
  onReload,
  onCommit,
  onNext,
}: {
  systemId: string;
  system: System;
  canEdit: boolean;
  onScaffolded: () => Promise<void> | void;
  onReload: () => Promise<void> | void;
  onCommit: (next: System) => void;
  onNext: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(system.system.name === 'Untitled system' ? '' : system.system.name);
  // Seed the describe box from the persisted team description so the judge's task and
  // the scaffold prompt share one source of truth (re-seeded when it changes server-side).
  const [desc, setDesc] = useState(system.system.description ?? '');
  const [scaffolding, setScaffolding] = useState(false);
  const [scaffoldErr, setScaffoldErr] = useState('');
  const hasAgents = system.agents.length > 0;
  const preset = system.safetyPreset ?? 'read-only';

  useEffect(() => { setName(system.system.name === 'Untitled system' ? '' : system.system.name); }, [system.system.name]);
  useEffect(() => { setDesc(system.system.description ?? ''); }, [system.system.description]);

  const saveName = () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === system.system.name) return;
    onCommit({ ...system, system: { ...system.system, name: trimmed } });
  };

  // Persist the describe text as the team's purpose (drives the Evaluate judge). Skipped
  // when unchanged so we never churn system.yaml on a no-op blur.
  const saveDesc = () => {
    if (desc.trim() === (system.system.description ?? '').trim()) return;
    onCommit(setDescription(system, desc));
  };

  const describe = async () => {
    const instruction = desc.trim();
    if (!instruction || scaffolding) return;
    const before = system.agents.length;
    setScaffolding(true);
    setScaffoldErr('');
    try {
      // The SAME scaffold endpoint the helper uses — edits system.yaml server-side.
      const res = await fetch(`/api/agents/systems/${systemId}/assistant`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ instruction }),
      });
      const raw = await res.text();
      let body: { error?: string } = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
      if (!res.ok) {
        const msg = body.error ?? 'The OS could not build that yet.';
        setScaffoldErr(msg);
        toast.error(msg);
        return;
      }
      // Persist the description so the Evaluate judge grades THIS task; the scaffold
      // reload re-seeds `desc` from it, so the box keeps what the author wrote.
      onCommit(setDescription(system, instruction));
      await onScaffolded();
      // Make the store UNMISTAKABLE: a success toast confirms the team changed, the
      // step-done tick fires (via onScaffolded), and we advance to Design so the new
      // agents are visible on screen. The button no longer looks like a no-op.
      toast.success(before > 0 ? 'Added to your team — see it in Design' : 'Your team is built — review it in Design');
    } catch (e) {
      const msg = (e as Error).message;
      setScaffoldErr(msg);
      toast.error(msg);
    } finally {
      setScaffolding(false);
    }
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

      {/* Description below — the describe→scaffold box */}
      <div className="sb-hero">
        <h2 className="sb-hero-title">Describe what your team should do</h2>
        <p className="sb-hero-sub">
          Say it in plain words, including what a good result looks like — the OS builds the agents,
          wires them up, and picks the right model for each. You review and adjust next.
        </p>
        <textarea
          className="sb-hero-input"
          rows={3}
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          onBlur={saveDesc}
          disabled={!canEdit || scaffolding}
          placeholder="e.g. a team that pulls campaign data, checks margins after returns, scores each campaign against the rules, and recommends budget changes"
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void describe(); } }}
        />
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginTop: 10 }}>
          <span className="hint" style={{ marginTop: 0 }}>⌘/Ctrl + Enter. Success criteria go here or in a granted Knowledge workflow.</span>
          <button className="btn" onClick={describe} disabled={!canEdit || scaffolding || !desc.trim()}>
            {scaffolding ? <span className="spin" /> : hasAgents ? 'Add to my team' : 'Build my team'}
          </button>
        </div>
        {scaffoldErr ? <div className="error" style={{ marginTop: 10 }}>{scaffoldErr}</div> : null}
      </div>

      {/* Safety / rights preset — surfaced on the FIRST page */}
      <div className="sb-resources" style={{ marginTop: 16 }}>
        <h2 className="sb-section-title" style={{ marginTop: 0 }}>What this team is allowed to do</h2>
        <p className="hint" style={{ marginTop: 0 }}>
          The safety preset bounds every agent — pick the least power the job needs.
        </p>
        <div className="rs-preset-grid">
          {PRESETS.map((p) => {
            const selected = preset === p.id;
            return (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={!canEdit}
                className={`rs-preset-option${selected ? ' rs-preset-option--selected' : ''}`}
                onClick={() => canEdit && !selected && onCommit({ ...system, safetyPreset: p.id })}
              >
                <div className="rs-preset-top">
                  <span className="rs-preset-name">{p.label}</span>
                  {selected && <span className="rs-preset-check" aria-hidden>✓</span>}
                </div>
                <p className="rs-preset-consequence">{p.consequence}</p>
              </button>
            );
          })}
        </div>
      </div>

      {/* How the team is triggered — part of team setup, so it lives on Define. */}
      <TriggerMode systemId={systemId} system={system} canEdit={canEdit} onReload={onReload} />

      {/* What your team can use — grants/resource picker, at the bottom of Define */}
      <TeamResources systemId={systemId} system={system} canEdit={canEdit} onCommit={onCommit} />

      {hasAgents ? (
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
          <button className="btn ghost sm" onClick={() => { saveName(); onNext(); }}>Design your team →</button>
        </div>
      ) : (
        <p className="hint">Or start empty and add agents yourself on the next step.</p>
      )}
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
  onBack,
  onNext,
  ready,
}: {
  systemId: string;
  system: System;
  canEdit: boolean;
  catalog: string[] | null;
  onCommit: (next: System) => void;
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
        <button className="btn ghost sm" onClick={onBack}>← Define</button>
        <button className="btn" onClick={onNext} disabled={!ready} title={ready ? 'Build' : 'Add at least one agent first'}>
          Build →
        </button>
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

      {/* LLM-judge — one click, scores against the system's task Description. */}
      <div className="row" style={{ alignItems: 'center', gap: 8, marginTop: 18 }}>
        <h2 className="sb-section-title" style={{ margin: 0 }}>AI judge</h2>
        <button className="btn primary" onClick={runJudge} disabled={judging || !canEdit || !output.trim()} title={output.trim() ? 'Score this run with the AI judge' : 'No output to judge'}>
          {judging ? <span className="spin" /> : judge ? 'Re-judge' : 'Judge this run'}
        </button>
      </div>
      <p className="hint" style={{ marginTop: 4 }}>
        The standard model scores the final output against what this team is meant to do — Clarity, Grounding, Actionability (1–5).
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

type Available = { id: string; name: string; scope: 'personal' | 'domain' | 'marketplace'; layers?: DataLayer[]; folder?: string };
type FolderNode = { path: string; scope: 'personal' | 'domain' };
type AvailableFeed = { items: Available[]; folders?: FolderNode[] };

/** Highest built layer of a dataset (Gold > Silver > Bronze), or null if none built. */
function highestLayer(layers: DataLayer[] | undefined): DataLayer | null {
  if (!layers || layers.length === 0) return null;
  if (layers.includes('gold')) return 'gold';
  if (layers.includes('silver')) return 'silver';
  if (layers.includes('bronze')) return 'bronze';
  return null;
}

/** The folder grants of a kind currently on the system (each `{path,scope}`). */
function folderGrantsOf(system: System, kind: 'data' | 'knowledge' | 'files'): FolderNode[] {
  return system.grants[kind]
    .filter((g) => g.folder)
    .map((g) => ({ path: g.folder!.path, scope: g.folder!.scope }));
}

/**
 * Apply a FolderTree {@link FolderSelection} onto the system for one foldered kind,
 * as a minimal diff that PRESERVES existing per-item write capabilities. Folder grants
 * and item grants both default to Read on first tick; the write toggle below the tree
 * is what lifts a specific grant. Files carry NO per-item list, so only their folder
 * grants are applied (individual file ticks are inert — surfaced in the UI hint).
 */
function applyFolderSelection(
  system: System,
  kind: 'data' | 'knowledge' | 'files',
  sel: FolderSelection,
  itemLayer: (id: string) => DataLayer,
  // When the knowledge feed is split into Workflows vs Knowledge, each picker
  // reconciles ONLY its own item family so it never removes the other's grants.
  // `manageFolders` is false for the Workflows picker (workflows carry no folders).
  opts: { inFamily?: (id: string) => boolean; manageFolders?: boolean } = {},
): System {
  const inFamily = opts.inFamily ?? (() => true);
  const manageFolders = opts.manageFolders ?? true;
  let next = system;
  const key = (f: { path: string; scope: string }) => `${f.scope}:${normaliseFolderPath(f.path)}`;

  // ── Folder grants: add newly-selected, remove de-selected. ──
  if (manageFolders) {
    const wantFolders = new Set(sel.folderGrants.map(key));
    const haveFolders = folderGrantsOf(system, kind);
    for (const f of sel.folderGrants) {
      if (!haveFolders.some((h) => key(h) === key(f))) next = setFolderGrant(next, kind, f, false);
    }
    for (const h of haveFolders) {
      if (!wantFolders.has(key(h))) next = removeFolderGrant(next, kind, h);
    }
  }

  // ── Item grants (data/knowledge only — files have no per-item list). ──
  if (kind !== 'files') {
    const wantItems = new Set(sel.itemGrants.filter(inFamily));
    const haveItems = next.grants[kind].filter((g) => !g.folder && g.id && inFamily(g.id)).map((g) => g.id);
    for (const id of wantItems) {
      if (!haveItems.includes(id)) next = setArtifactGrant(next, kind, id, false, itemLayer(id));
    }
    for (const id of haveItems) {
      if (!wantItems.has(id)) next = removeArtifactGrant(next, kind, id);
    }
  }
  return next;
}

/**
 * Wave-3 folder-aware grant picker for the FOLDERED kinds (data · knowledge · files).
 * Renders the shared `<FolderTree variant="checkbox">` over the DLS-scoped feed so the
 * author ticks whole FOLDERS (→ a folder grant that late-binds to every item under it,
 * incl. future ones) or individual ITEMS. The feed is already DLS-scoped, so only
 * grantable items show — a folder that also holds ungrantable items simply renders as
 * a partial (tri-state) tick, honest by construction. Granted resources are listed
 * below with their access toggle (Read / Can-write) + medallion layer (data), reusing
 * the same controls the flat picker used. Marketplace items (no folder tree) keep a
 * small supplementary add-picker so nothing that was grantable before is lost.
 */
function FolderResourcePicker({
  systemId, system, kind, label, canEdit, onCommit, idFamily, hideLabel,
}: {
  systemId: string;
  system: System;
  kind: 'data' | 'knowledge' | 'files';
  label: string;
  canEdit: boolean;
  onCommit: (next: System) => void;
  /** Knowledge feed only — narrow to workflows (`wf_…`) or knowledge docs (everything else). */
  idFamily?: 'workflow' | 'knowledge';
  /** Suppress the internal category label — the caller renders a prominent one. */
  hideLabel?: boolean;
}) {
  const [feed, setFeed] = useState<AvailableFeed | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [mktOpen, setMktOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoadErr('');
    fetch(`/api/agents/systems/${systemId}/grants/available?kind=${kind}`, { cache: 'no-store' })
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? 'Failed to load');
        if (alive) setFeed(body as AvailableFeed);
      })
      .catch((e) => { if (alive) setLoadErr((e as Error).message); });
    return () => { alive = false; };
  }, [systemId, kind]);

  // Split the shared knowledge feed so Workflows (own Plan-Items member) and Knowledge
  // (Context) each show ONLY their own item family. Other kinds pass every item.
  const inFamily = (id: string) =>
    !idFamily ? true : idFamily === 'workflow' ? isWorkflowId(id) : !isWorkflowId(id);
  const items = (feed?.items ?? []).filter((a) => inFamily(a.id));
  const folders = feed?.folders ?? [];
  const availOf = (id: string) => items.find((a) => a.id === id);
  const nameOf = (id: string) => availOf(id)?.name ?? (id.includes('_') ? id.split('_').slice(1).join('_') : id);
  const layersOf = (id: string): DataLayer[] => availOf(id)?.layers ?? [];
  const layerFor = (id: string): DataLayer => (kind === 'data' ? (highestLayer(layersOf(id)) ?? 'gold') : 'gold');

  // Split the feed: foldered (personal/domain) items feed the tree; marketplace items
  // (no folder tree) keep a flat supplementary picker. Each tree item carries its
  // scope so the FolderTree shows it under ONLY its own root (My vs Shared) — a
  // root-level dataset/workflow is no longer listed twice.
  const treeItems = items
    .filter((a) => a.scope === 'personal' || a.scope === 'domain')
    .map((a) => ({ id: a.id, folder: a.folder ?? '/', name: a.name, scope: a.scope as 'personal' | 'domain' }));
  const personalNodes = folders.filter((f) => f.scope === 'personal').map((f) => ({ path: f.path }));
  const domainNodes = folders.filter((f) => f.scope === 'domain').map((f) => ({ path: f.path }));
  const mktItems = items.filter((a) => a.scope === 'marketplace');

  // Currently-checked ids = explicit item grants ∪ every feed item under a granted folder
  // (so a folder grant renders as a fully-ticked folder). Files: only folders drive checks.
  // Workflows carry no folders, so the Workflows picker manages item grants only.
  const managesFolders = idFamily !== 'workflow';
  const grantList = system.grants[kind];
  const itemGrantIds = new Set(grantList.filter((g) => !g.folder && g.id && inFamily(g.id)).map((g) => g.id));
  const checked = new Set<string>(kind === 'files' ? [] : itemGrantIds);
  for (const g of grantList) {
    if (!g.folder) continue;
    for (const it of itemsUnderFolder(g.folder.path, treeItems)) checked.add(it.id);
  }

  const onChange = (sel: FolderSelection) => {
    if (!canEdit) return;
    onCommit(applyFolderSelection(system, kind, sel, layerFor, { inFamily, manageFolders: managesFolders }));
  };

  // The granted chips (item grants + folder grants) shown below the tree with controls.
  const grantedItems = grantList.filter((g) => !g.folder && g.id && inFamily(g.id));
  const grantedFolders = managesFolders ? grantList.filter((g) => g.folder) : [];
  const cap = accessCap(system.safetyPreset);
  const scopeOf = (id: string): 'personal' | 'domain' | 'marketplace' => availOf(id)?.scope ?? 'personal';
  const mktGrantedIds = new Set(grantedItems.map((g) => g.id));
  const addableMkt = mktItems.filter((a) => !mktGrantedIds.has(a.id));

  return (
    <div className="sb-resource">
      {hideLabel ? null : <div className="sb-field-label" style={{ margin: '4px 0' }}>{label}</div>}
      {loadErr ? <div className="error" style={{ marginBottom: 6 }}>{loadErr}</div> : null}
      {feed === null ? (
        <p className="hint" style={{ marginTop: 0 }}>Loading…</p>
      ) : treeItems.length === 0 && folders.length === 0 ? (
        <p className="hint" style={{ marginTop: 0 }}>Nothing to grant — create or share {label.toLowerCase()} first.</p>
      ) : (
        <FolderTree
          variant="checkbox"
          personalNodes={personalNodes}
          domainNodes={domainNodes}
          items={treeItems}
          checkedIds={[...checked]}
          onChange={onChange}
          // Files grant by FOLDER only — a per-file tick is inert, so show file
          // leaves display-only (no dead checkboxes). Folders stay tickable, and a
          // checkable "All …" root row lets you grant files that sit at the root
          // (no named subfolder) as one `/` grant.
          leavesSelectable={kind !== 'files'}
          rootGrantable={kind === 'files'}
        />
      )}

      {/* Granted-resource controls — access level + (data) medallion layer. */}
      {(grantedItems.length > 0 || grantedFolders.length > 0) ? (
        <div className="sb-chips" style={{ marginTop: 8 }}>
          {grantedFolders.map((g) => (
            <span key={`f:${g.folder!.scope}:${g.folder!.path}`} className="sb-chip granted" style={{ gap: 8 }}>
              <span>📁 {g.folder!.path === '/' ? 'All' : g.folder!.path}<span className="badge muted" style={{ marginLeft: 6 }}>{scopeLabel(g.folder!.scope === 'domain' ? 'shared' : 'mine')}</span></span>
              {/* Files are folder-granted only, so the folder chip carries the SAME access
                  selector item grants use — this is the only place a Files write can be set.
                  `cap` (from the system safety preset) bounds it exactly like every kind. */}
              <AccessLevelSelect
                cap={cap}
                capability={g.capability}
                canEdit={canEdit}
                onLevel={(l) => onCommit(setFolderGrantLevel(system, kind, g.folder!, l))}
              />
              {canEdit ? (
                <button className="sb-chip-x" title="Remove" onClick={() => onCommit(removeFolderGrant(system, kind, g.folder!))}>✕</button>
              ) : null}
            </span>
          ))}
          {grantedItems.map((g) => (
            <span key={g.id} className="sb-chip granted" style={{ gap: 8 }}>
              <span>{nameOf(g.id)}<span className="badge muted" style={{ marginLeft: 6 }}>{scopeLabel(scopeKeyOf(scopeOf(g.id)))}</span></span>
              <AccessLevelSelect
                cap={cap}
                capability={g.capability}
                canEdit={canEdit}
                onLevel={(l) => onCommit(setArtifactGrantLevel(system, kind, g.id, l))}
              />
              {kind === 'data' ? (
                <LayerToggle
                  layer={g.layer ?? highestLayer(layersOf(g.id)) ?? 'gold'}
                  built={layersOf(g.id)}
                  canEdit={canEdit}
                  onPick={(l) => onCommit(setDataGrantLayer(system, g.id, l))}
                />
              ) : null}
              {canEdit ? (
                <button className="sb-chip-x" title="Remove" onClick={() => onCommit(removeArtifactGrant(system, kind, g.id))}>✕</button>
              ) : null}
            </span>
          ))}
        </div>
      ) : null}

      {kind === 'files' ? (
        <p className="hint" style={{ marginTop: 6, marginBottom: 0 }}>
          Files are granted by <strong>folder</strong> — tick a folder to give the team every file under it (now and later).
          Access follows the file store’s own permissions at run time.
        </p>
      ) : null}

      {/* Marketplace supplementary picker — foldered trees only cover personal + domain. */}
      {kind !== 'files' && canEdit && mktItems.length > 0 ? (
        !mktOpen ? (
          <button className="btn ghost sm" style={{ marginTop: 6 }} onClick={() => setMktOpen(true)}>
            + Add from marketplace
          </button>
        ) : (
          <div className="sb-resource-picker">
            {addableMkt.length === 0 ? (
              <p className="hint" style={{ marginTop: 0 }}>Nothing left to add.</p>
            ) : (
              <div className="sb-picker-list">
                {addableMkt.map((a) => (
                  <button
                    key={a.id}
                    className="sb-picker-row"
                    title={a.id}
                    onClick={() => onCommit(setArtifactGrantLevel(system, kind, a.id, cap.default, layerFor(a.id)))}
                  >
                    +<span>{a.name}</span><span className="badge muted">{scopeLabel(scopeKeyOf(a.scope))}</span>
                  </button>
                ))}
              </div>
            )}
            <button className="btn ghost sm" style={{ marginTop: 8 }} onClick={() => setMktOpen(false)}>Done</button>
          </div>
        )
      ) : null}
    </div>
  );
}

/**
 * Simple-mode "What your team can use" — the plain grant section for the four resource
 * kinds (Data · Knowledge · Files · Connections), each at a Read / Can-write access
 * level. Granting AUTO-PROVISIONS the matching governed tools via `setArtifactGrant`,
 * so the label is truthful. Data/Knowledge/Connections carry per-artifact id lists
 * (picker); Files have no id list, so it is a single Read/Write toggle. Shown in Design.
 */
function TeamResources({
  systemId, system, canEdit, onCommit,
}: {
  systemId: string;
  system: System;
  canEdit: boolean;
  onCommit: (next: System) => void;
}) {
  const cap = accessCap(system.safetyPreset);
  return (
    <div className="sb-resources">
      <h2 className="sb-section-title" style={{ marginTop: 0 }}>What your team can use</h2>
      <p className="hint" style={{ marginTop: 0 }}>
        Give the whole team the resources it needs — every agent shares these. For each item, choose{' '}
        <strong>Read-only</strong>, <strong>Read + propose</strong> (writes wait for a human), or{' '}
        <strong>Read + write</strong> (writes run directly). The matching tools are granted automatically.
      </p>

      {/* The system-wide access cap, explained — why items may be locked or capped. */}
      <AccessCapNote cap={cap} preset={system.safetyPreset} />

      {/* ① Plan Items ─ Strategy · Big Bets · Operating Manual · Workflows */}
      <ResourceSectionBlock
        title="① Plan Items"
        subtitle="Your strategy, big bets, operating manual and workflows."
        members={membersOf('plan')}
        systemId={systemId} system={system} canEdit={canEdit} onCommit={onCommit}
      />

      {/* ② Context ─ Knowledge · Files · Data · Connections · Metrics */}
      <ResourceSectionBlock
        title="② Context"
        subtitle="The folders and items the team reads from and writes to."
        members={membersOf('context')}
        systemId={systemId} system={system} canEdit={canEdit} onCommit={onCommit}
      />
    </div>
  );
}

/**
 * The inline explanation of the agent-system-wide access cap. Reads the system's
 * safety preset and says, in one honest line, HOW the per-item selector is bounded:
 * locked at the extremes (read-only / full-in-scope), downgrade-only in the middle.
 */
function AccessCapNote({ cap, preset }: { cap: AccessCap; preset: SafetyPreset }) {
  const msg = cap.locked
    ? cap.reason
    : preset === 'read-bounded'
      ? 'The system allows writes in-scope — each item defaults to Read + write; you may downgrade any item, never go above it.'
      : 'The system default is Read + propose — each item defaults to that; you may downgrade any item to Read-only, never grant direct write above the system setting.';
  return (
    <div className={`badge ${cap.locked ? 'warn' : 'muted'}`} role="note" style={{ display: 'block', padding: '8px 10px', marginBottom: 10, lineHeight: 1.4, whiteSpace: 'normal' }}>
      {cap.locked ? '🔒 ' : 'ℹ '}{msg} Change it under <strong>What this team is allowed to do</strong> above.
    </div>
  );
}

/** One labelled section (Plan Items / Context) rendering its members' grant pickers. */
function ResourceSectionBlock({
  title, subtitle, members, systemId, system, canEdit, onCommit,
}: {
  title: string;
  subtitle: string;
  members: ResourceMember[];
  systemId: string;
  system: System;
  canEdit: boolean;
  onCommit: (next: System) => void;
}) {
  return (
    <div className="sb-grant-group">
      <div className="sb-grant-group-title">{title}</div>
      <p className="sb-grant-group-sub">{subtitle}</p>
      {members.map((m) => (
        <ResourceMemberBlock
          key={m.key}
          member={m}
          systemId={systemId} system={system} canEdit={canEdit} onCommit={onCommit}
        />
      ))}
    </div>
  );
}

/**
 * Render ONE group member. Wireable members route to the right picker (foldered tree
 * for data/knowledge/files/workflows, flat picker for connections/metrics and the three
 * Plan items — Operating Manual · Strategy · Big Bets — through the shared `plan` grant
 * list). A non-wireable member (none today) would render a labelled, honest note so the
 * IA stays complete without inventing a grant channel.
 */
function ResourceMemberBlock({
  member, systemId, system, canEdit, onCommit,
}: {
  member: ResourceMember;
  systemId: string;
  system: System;
  canEdit: boolean;
  onCommit: (next: System) => void;
}) {
  // Each category is a titled card — the prominent CATEGORY heading lives HERE (the
  // pickers render their My/Domain/Company sub-labels beneath it), so the heading
  // hierarchy reads group → category → scope.
  return (
    <div className="sb-grant-cat">
      <div className="sb-grant-cat-title">{member.label}</div>
      {!member.wireable ? (
        <p className="hint" style={{ marginTop: 0, marginBottom: 0 }}>{member.note}</p>
      ) : member.feedKind === 'data' || member.feedKind === 'knowledge' || member.feedKind === 'files' ? (
        // Foldered kinds (data · knowledge · files) + Workflows (knowledge feed, wf_ family).
        <FolderResourcePicker
          systemId={systemId} system={system}
          kind={member.feedKind}
          idFamily={member.idFamily}
          label={member.label}
          hideLabel
          canEdit={canEdit} onCommit={onCommit}
        />
      ) : (
        // Flat kinds — Connections · Metrics · Plan Items (Operating Manual · Strategy · Big Bets).
        <ResourcePicker
          systemId={systemId} system={system}
          kind={member.field as 'connections' | 'metrics' | 'plan'}
          feedKind={member.feedKind as 'connections' | 'metric' | 'operating-manual' | 'strategy' | 'big-bets'}
          label={member.label}
          hideLabel
          canEdit={canEdit} onCommit={onCommit}
        />
      )}
    </div>
  );
}

/** Map the grants-available `scope` string to a core `ScopeKey` for `scopeLabel`. */
function scopeKeyOf(scope: 'personal' | 'domain' | 'marketplace'): ScopeKey {
  return scope === 'domain' ? 'shared' : scope === 'marketplace' ? 'marketplace' : 'mine';
}

/** Per-level tooltip — what each access level actually grants, in plain words. */
const ACCESS_HINTS: Record<AccessLevel, string> = {
  'read-only': 'Can read only — never changes anything.',
  'read-propose': 'Can suggest changes — a human approves each one before it runs.',
  'read-write': 'Can change directly — no approval step.',
};

/**
 * The per-item ACCESS-LEVEL selector — a labelled three-option SEGMENTED control
 * (Read-only · Read + propose · Read + write) CAPPED by the agent-system-wide safety
 * preset (`cap`). It offers only the levels at or below the system ceiling.
 *
 * Fully CONTROLLED — the highlighted option is derived ONLY from the persisted
 * `capability` prop (clamped to the cap), never from local optimistic state, so there
 * is NO flicker or press-then-revert repaint: the commit awaits the reload and the
 * segment repaints once, cleanly, to the new value. The active option is always shown
 * filled with its text label, so the current level is unambiguous at a glance.
 *
 * When the system is LOCKED (read-only / full-in-scope) the control is non-interactive
 * but still legible: the fixed level stays highlighted, dimmed, with a 🔒 and the reason.
 */
function AccessLevelSelect({
  cap, capability, canEdit, onLevel,
}: {
  cap: AccessCap;
  capability: string;
  canEdit: boolean;
  onLevel: (level: AccessLevel) => void;
}) {
  const current = clampAccess(capabilityToAccess(capability as Parameters<typeof capabilityToAccess>[0]), cap);
  const options = allowedAccessLevels(cap);
  const interactive = canEdit && !cap.locked;
  return (
    <span
      className={`sb-access-seg${cap.locked ? ' locked' : ''}`}
      role="radiogroup"
      aria-label="Access level"
      title={cap.locked ? cap.reason : undefined}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}
    >
      {options.map((l) => {
        const active = l === current;
        return (
          <button
            key={l}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={!interactive}
            title={ACCESS_HINTS[l] + (cap.locked ? ` — ${cap.reason}` : '')}
            className={`sb-access-seg-btn${active ? ' active' : ''}`}
            onClick={() => interactive && !active && onLevel(l)}
          >
            {cap.locked && active ? '🔒 ' : ''}{ACCESS_LABELS[l]}
          </button>
        );
      })}
    </span>
  );
}

/**
 * Bronze · Silver · Gold segmented selector for ONE granted dataset (DATA grants
 * only). Renders ONLY the medallion layers that are actually BUILT for this dataset
 * — so a user can never pick an unbuilt (unqueryable) layer. Hidden entirely when
 * the dataset exposes a single layer (nothing to choose). Gold, when built, is the
 * curated serving default; picking silver/bronze routes the team's discovery + reads
 * to that layer's physical table.
 */
const LAYER_ORDER: DataLayer[] = ['bronze', 'silver', 'gold'];
function LayerToggle({
  layer, built, canEdit, onPick,
}: {
  layer: DataLayer;
  /** The dataset's built medallion layers (from the grant-available feed). */
  built: DataLayer[];
  canEdit: boolean;
  onPick: (layer: DataLayer) => void;
}) {
  const choices = LAYER_ORDER.filter((l) => built.includes(l));
  // Nothing to choose (0 or 1 built layer) → no selector at all.
  if (choices.length < 2) return null;
  return (
    <span className="sb-layer" role="group" aria-label="Medallion layer" style={{ display: 'inline-flex', gap: 4 }}>
      {choices.map((l) => (
        <button
          key={l}
          type="button"
          className={`btn ghost sm${l === layer ? ' active' : ''}`}
          aria-pressed={l === layer}
          disabled={!canEdit}
          title={`Read the ${l} layer`}
          onClick={() => canEdit && l !== layer && onPick(l)}
        >
          {l.charAt(0).toUpperCase() + l.slice(1)}
        </button>
      ))}
    </span>
  );
}

function ResourcePicker({
  systemId, system, kind, feedKind, label, canEdit, onCommit, hideLabel,
}: {
  systemId: string;
  system: System;
  /** An id-carrying grant kind (Files is handled separately by FolderResourcePicker).
   *  `plan` holds heterogeneous Plan grants — Operating Manual (`manual:<scope>`),
   *  Strategic Pillar (`pillar:<id>`) and Big Bet (`bigbet:<id>`) ids. */
  kind: 'data' | 'knowledge' | 'connections' | 'metrics' | 'plan';
  /** The `…/grants/available?kind=` feed to browse — `metric` (singular) for metrics;
   *  `operating-manual` · `strategy` · `big-bets` for the three plan feeds. */
  feedKind: 'data' | 'knowledge' | 'connections' | 'metric' | 'operating-manual' | 'strategy' | 'big-bets';
  label: string;
  /** Suppress the internal category label — the caller renders a prominent one. */
  hideLabel?: boolean;
  canEdit: boolean;
  onCommit: (next: System) => void;
}) {
  const [available, setAvailable] = useState<Available[] | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  useEffect(() => {
    let alive = true;
    setLoadErr('');
    fetch(`/api/agents/systems/${systemId}/grants/available?kind=${feedKind}`, { cache: 'no-store' })
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? 'Failed to load');
        if (alive) setAvailable(body.items as Available[]);
      })
      .catch((e) => { if (alive) setLoadErr((e as Error).message); });
    return () => { alive = false; };
  }, [systemId, feedKind]);

  const granted = system.grants[kind];
  const availOf = (id: string) => available?.find((a) => a.id === id);
  const nameOf = (id: string) =>
    availOf(id)?.name
    ?? (id.includes('_') ? id.split('_').slice(1).join('_') : id);
  const scopeOf = (id: string): 'personal' | 'domain' | 'marketplace' => availOf(id)?.scope ?? 'personal';
  /** Built medallion layers for a granted dataset (empty until `available` loads). */
  const layersOf = (id: string): DataLayer[] => availOf(id)?.layers ?? [];
  const grantedIds = new Set(granted.map((g) => g.id));
  const addable = (available ?? []).filter((a) => !grantedIds.has(a.id));
  const q = search.trim().toLowerCase();
  const shown = q ? addable.filter((a) => a.name.toLowerCase().includes(q) || a.id.toLowerCase().includes(q)) : addable;
  // Metrics + Plan (Operating Manual) are read-only (no agent author path) — cap the
  // selector at read-only regardless of the system posture; other kinds obey the full cap.
  const readOnlyKind = kind === 'metrics' || kind === 'plan';
  const baseCap = accessCap(system.safetyPreset);
  const cap: AccessCap = readOnlyKind
    ? { ...baseCap, ceiling: 'read-only', default: 'read-only', reason: baseCap.reason || `${label} is read-only.` }
    : baseCap;

  return (
    <div className="sb-resource">
      {hideLabel ? null : <div className="sb-field-label" style={{ margin: '4px 0' }}>{label}</div>}
      {loadErr ? <div className="error" style={{ marginBottom: 6 }}>{loadErr}</div> : null}
      <div className="sb-chips">
        {granted.length === 0 ? <span className="hint" style={{ marginTop: 0 }}>None yet.</span> : null}
        {granted.map((g) => (
          <span key={g.id} className="sb-chip granted" style={{ gap: 8 }}>
            <span>{nameOf(g.id)}<span className="badge muted" style={{ marginLeft: 6 }}>{scopeLabel(scopeKeyOf(scopeOf(g.id)))}</span></span>
            {readOnlyKind ? null : (
              <AccessLevelSelect
                cap={cap}
                capability={g.capability}
                canEdit={canEdit}
                onLevel={(l) => onCommit(setArtifactGrantLevel(system, kind, g.id, l))}
              />
            )}
            {kind === 'data' ? (
              <LayerToggle
                layer={g.layer ?? highestLayer(layersOf(g.id)) ?? 'gold'}
                built={layersOf(g.id)}
                canEdit={canEdit}
                onPick={(l) => onCommit(setDataGrantLayer(system, g.id, l))}
              />
            ) : null}
            {canEdit ? (
              <button className="sb-chip-x" title="Remove" onClick={() => onCommit(removeArtifactGrant(system, kind, g.id))}>✕</button>
            ) : null}
          </span>
        ))}
      </div>
      {kind === 'data' && granted.length > 0 ? (
        <p className="hint" style={{ marginTop: 4, marginBottom: 0 }}>
          Which refined layer this team reads — Gold is the curated default.
        </p>
      ) : null}
      {kind === 'plan' ? (
        <p className="hint" style={{ marginTop: 4, marginBottom: 0 }}>
          {feedKind === 'strategy' ? (
            <>A granted pillar is loaded on demand via the governed <span className="mono">get_pillar</span> tool, scope-checked as you. Nothing is auto-injected — the read tool + your access is the only path it reaches the team.</>
          ) : feedKind === 'big-bets' ? (
            <>A granted big bet is loaded on demand via the governed <span className="mono">get_big_bet</span> tool, scope-checked as you. Nothing is auto-injected — the read tool + your access is the only path it reaches the team.</>
          ) : (
            <>A granted manual is loaded on demand via the governed <span className="mono">get_operating_manual</span> tool, scope-checked as you. Nothing is auto-injected — grant the Domain manual to have the team load it explicitly.</>
          )}
        </p>
      ) : null}
      {canEdit ? (
        !open ? (
          <button className="btn ghost sm" style={{ marginTop: 6 }} disabled={available === null} onClick={() => setOpen(true)}>
            + Add {label.toLowerCase()}
          </button>
        ) : (
          <div className="sb-resource-picker">
            {addable.length > 6 ? (
              <input
                type="text"
                autoFocus
                placeholder={`Search ${label.toLowerCase()}…`}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                style={{ width: '100%', marginBottom: 8 }}
              />
            ) : null}
            {shown.length === 0 ? (
              <p className="hint" style={{ marginTop: 0 }}>
                {addable.length === 0 ? `Nothing to add — create or share ${label.toLowerCase()} first.` : 'No matches.'}
              </p>
            ) : (
              <div className="sb-picker-list">
                {shown.map((a) => (
                  <button
                    key={a.id}
                    className="sb-picker-row"
                    title={a.id}
                    onClick={() =>
                      // A newly-granted item adopts the system posture's DEFAULT access
                      // level (the author can then downgrade it). DATA grants default to
                      // the HIGHEST built layer; non-data kinds ignore the layer arg.
                      onCommit(setArtifactGrantLevel(system, kind, a.id, cap.default, highestLayer(a.layers) ?? 'gold'))
                    }
                  >
                    +<span>{a.name}</span><span className="badge muted">{scopeLabel(scopeKeyOf(a.scope))}</span>
                  </button>
                ))}
              </div>
            )}
            <button className="btn ghost sm" style={{ marginTop: 8 }} onClick={() => { setOpen(false); setSearch(''); }}>Done</button>
          </div>
        )
      ) : null}
    </div>
  );
}
