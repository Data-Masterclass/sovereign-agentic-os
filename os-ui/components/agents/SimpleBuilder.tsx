/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import BuildRunPanel from './BuildRunPanel';
import RecurrenceEditor from './RecurrenceEditor';
import type { System, SafetyPreset, DataLayer } from '@/lib/agents/system-schema';
import { classifyModelNeed } from '@/lib/agents/routing';
import { instructionsOf } from '@/lib/agents/agent-md';
import {
  addSimpleAgent, moveAgent, removeAgentSimple,
  setAgentInstructions, setAgentRole, setArtifactGrant, removeArtifactGrant,
  setDescription, addAgentTool, removeAgentTool, setDataGrantLayer,
} from '@/lib/agents/simple-edit';
import { writeToolsForKind, type GrantKind } from '@/lib/agents/capability-tools';
import { setEntrypoint } from '@/lib/agents/canvas-edit';
import { suggestTools } from '@/lib/agents/suggest-tools';
import { AGENT_TEMPLATES, agentTemplate, type AgentTemplateKey } from '@/lib/agents/agent-templates';
import { runChecks, allChecksPass } from '@/lib/agents/build/run-checks';
import type { DiagRun } from '@/lib/agents/build/run-diagnostics';
import { dimensionLabel, type JudgeResult } from '@/lib/agents/evaluate-judge';

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
 */

type Phase = 'define' | 'design' | 'build' | 'run' | 'evaluate';
const PHASES: { key: Phase; label: string }[] = [
  { key: 'define', label: 'Define' },
  { key: 'design', label: 'Design' },
  { key: 'build', label: 'Build' },
  { key: 'run', label: 'Run' },
  { key: 'evaluate', label: 'Evaluate' },
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
  const [phase, setPhase] = useState<Phase>('define');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const editable = canEdit && !busy;
  const hasAgents = system.agents.length > 0;
  const ready = hasAgents && !!system.entrypoint;
  const hasRun = !!buildRun.lastRun && ((buildRun.lastRun.nodes?.length ?? 0) > 0 || !!buildRun.lastRun.output);

  // Advance to Design automatically once the system has agents (e.g. after a scaffold
  // or the first add) — but never yank a user who stepped back.
  const autoAdvanced = useRef(false);
  useEffect(() => {
    if (hasAgents && !autoAdvanced.current) { autoAdvanced.current = true; setPhase('design'); }
  }, [hasAgents]);

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

  // Which phases are reachable — you can't Build/Run/Evaluate without a team, and you
  // can't Evaluate without a run.
  const enabled: Record<Phase, boolean> = {
    define: true,
    design: true,
    build: ready,
    run: ready,
    evaluate: ready && hasRun,
  };
  const doneOf = (p: Phase): boolean => {
    if (p === 'define') return !!system.system.name && system.system.name !== 'Untitled system';
    if (p === 'design') return ready;
    if (p === 'build') return !!buildRun.lastBuild?.ok; // a green ✓ once the team is built
    if (p === 'run') return hasRun;
    // Evaluate is ✓ once a run's deterministic checks all pass (the "✓ all passed" state).
    if (p === 'evaluate') return hasRun && allChecksPass(runChecks(lastRunToDiag(buildRun.lastRun!)));
    return false;
  };

  return (
    <div className="simple-builder">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <ol className="sb-steps" aria-label="Build phases" style={{ marginBottom: 0 }}>
          {PHASES.map((ph, i) => (
            <li key={ph.key} className={`sb-step${phase === ph.key ? ' active' : ''}${doneOf(ph.key) ? ' done' : ''}`}>
              <button type="button" onClick={() => setPhase(ph.key)} disabled={!enabled[ph.key]}>
                <span className="sb-step-n">{doneOf(ph.key) ? '✓' : i + 1}</span>
                <span className="sb-step-label">{ph.label}</span>
              </button>
            </li>
          ))}
        </ol>
        {/* Runtime badge — read-only, tells the author which engine runs their team. */}
        {hasAgents ? (
          <span className="badge" title={`This team runs on the ${system.runtime} runtime`}>
            {system.runtime === 'hermes' ? 'Autonomous (Hermes)' : 'Graph (LangGraph)'}
          </span>
        ) : null}
      </div>

      {err ? <div className="error" style={{ marginBottom: 12 }}>{err}</div> : null}

      {phase === 'define' ? (
        <DefineStep
          systemId={systemId}
          system={system}
          canEdit={editable}
          onScaffolded={async () => { await onReload(); setPhase('design'); }}
          onReload={onReload}
          onCommit={(next) => commit(next)}
          onNext={() => setPhase('design')}
        />
      ) : null}

      {phase === 'design' ? (
        <DesignStep
          systemId={systemId}
          system={system}
          canEdit={editable}
          catalog={catalog}
          onCommit={commit}
          onBack={() => setPhase('define')}
          onNext={() => ready && setPhase('build')}
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
            <button className="btn ghost sm" onClick={() => setPhase('design')}>← Design</button>
            <button className="btn" onClick={() => setPhase('run')}>Run →</button>
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
            <button className="btn ghost sm" onClick={() => setPhase('build')}>← Build</button>
            <button className="btn" onClick={() => setPhase('evaluate')} disabled={!hasRun} title={hasRun ? 'Evaluate the run' : 'Run the team first'}>Evaluate →</button>
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
          <EvaluateStep systemId={systemId} lastRun={buildRun.lastRun} canEdit={editable} />
          <BuildRunPanel
            systemId={systemId}
            running={buildRun.running}
            canEdit={canEdit}
            lastBuild={buildRun.lastBuild}
            activity={buildRun.activity}
            lastRun={buildRun.lastRun}
            nodePath={buildRun.nodePath}
            onStateChange={onReload}
            phase="evaluate"
          />
          <button className="btn ghost sm" style={{ marginTop: 14 }} onClick={() => setPhase('run')}>← Back to Run</button>
        </div>
      ) : null}
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
      if (!res.ok) { setScaffoldErr(body.error ?? 'The OS could not build that yet.'); return; }
      // Persist the description so the Evaluate judge grades THIS task; the scaffold
      // reload re-seeds `desc` from it, so the box keeps what the author wrote.
      onCommit(setDescription(system, instruction));
      await onScaffolded();
    } catch (e) {
      setScaffoldErr((e as Error).message);
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

  // Add a curated template: create the agent, then apply its suggested tools that the
  // caller's role-floor catalog allows (never grant a tool outside the catalog).
  const addTemplate = (key: AgentTemplateKey) => {
    const tpl = agentTemplate(key);
    let next = addSimpleAgent(system, { role: tpl.role, instructions: tpl.instructions });
    const added = next.agents[next.agents.length - 1];
    for (const t of tpl.suggestedTools ?? []) {
      if (!catalog || catalog.includes(t)) next = addAgentTool(next, added.id, t);
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
      <TeamResources systemId={systemId} system={system} canEdit={canEdit} onCommit={onCommit} />

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

  const suggestions = useMemo(() => {
    const text = `${agent.id} ${role} ${instr}`;
    return suggestTools(text, catalog ?? undefined).filter((s) => !effectiveTools.includes(s.tool));
  }, [agent.id, role, instr, catalog, effectiveTools]);

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
        <span className="mono sb-card-id">{agent.id}</span>
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

      <label className="sb-field-label" htmlFor={`role-${agentId}`}>Role — one line</label>
      <input
        id={`role-${agentId}`}
        type="text"
        value={role}
        disabled={!canEdit}
        onChange={(e) => setRole(e.target.value)}
        onBlur={saveRole}
        placeholder="e.g. Analyzes sources and explains the findings"
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

      <div className="sb-tools">
        <span className="sb-field-label" style={{ margin: '4px 0' }}>Tools this agent can use</span>
        <div className="sb-chips">
          {effectiveTools.length === 0 ? <span className="hint" style={{ marginTop: 0 }}>None yet — accept a suggestion below.</span> : null}
          {effectiveTools.map((t) => (
            <span key={t} className="sb-chip granted">
              <span className="mono">{t}</span>
              {canEdit ? (
                <button className="sb-chip-x" title="Remove" onClick={() => onCommit(removeAgentTool(system, agentId, t))}>✕</button>
              ) : null}
            </span>
          ))}
        </div>
        {suggestions.length > 0 && canEdit ? (
          <div className="sb-suggest">
            <span className="hint" style={{ marginTop: 0 }}>Suggested for this role:</span>
            <div className="sb-chips">
              {suggestions.map((s) => (
                <button
                  key={s.tool}
                  className="sb-chip suggest"
                  title={s.why}
                  onClick={() => onCommit(addAgentTool(system, agentId, s.tool))}
                >
                  + <span className="mono">{s.tool}</span>
                  <span className="sb-chip-why">{s.why}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
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
      await onReload();
    } catch (e) {
      setErr((e as Error).message);
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
  systemId, lastRun, canEdit,
}: {
  systemId: string;
  lastRun: BuildRunProps['lastRun'];
  canEdit: boolean;
}) {
  const [judge, setJudge] = useState<JudgeResult | null>(null);
  const [judging, setJudging] = useState(false);
  const [judgeErr, setJudgeErr] = useState('');

  const checks = useMemo(() => (lastRun ? runChecks(lastRunToDiag(lastRun)) : []), [lastRun]);
  const output = lastRun?.output ?? '';

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
        <button className="btn sm" onClick={runJudge} disabled={judging || !canEdit || !output.trim()} title={output.trim() ? 'Score this run with the AI judge' : 'No output to judge'}>
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

type Available = { id: string; name: string; scope: 'personal' | 'domain' | 'marketplace'; layers?: DataLayer[] };

/** Highest built layer of a dataset (Gold > Silver > Bronze), or null if none built. */
function highestLayer(layers: DataLayer[] | undefined): DataLayer | null {
  if (!layers || layers.length === 0) return null;
  if (layers.includes('gold')) return 'gold';
  if (layers.includes('silver')) return 'silver';
  if (layers.includes('bronze')) return 'bronze';
  return null;
}

/** True when the write tools for `kind` are all present in the team's tool pool. */
function hasWriteTools(system: System, kind: GrantKind): boolean {
  const w = writeToolsForKind(kind);
  return w.length > 0 && w.every((t) => system.grants.tools.includes(t));
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
  return (
    <div className="sb-resources">
      <h2 className="sb-section-title" style={{ marginTop: 0 }}>What your team can use</h2>
      <p className="hint" style={{ marginTop: 0 }}>
        Give the whole team the data, knowledge, files and connections it needs — every agent shares
        these. Choose <strong>Read</strong> to look only, or <strong>Can write</strong> to also create
        and change. The matching tools are granted automatically.
      </p>
      <ResourcePicker systemId={systemId} system={system} kind="data" label="Data" canEdit={canEdit} onCommit={onCommit} />
      <ResourcePicker systemId={systemId} system={system} kind="knowledge" label="Knowledge" canEdit={canEdit} onCommit={onCommit} />
      <FilesGrant system={system} canEdit={canEdit} onCommit={onCommit} />
      <ResourcePicker systemId={systemId} system={system} kind="connections" label="Connections" canEdit={canEdit} onCommit={onCommit} />
      <p className="hint" style={{ marginTop: 8, marginBottom: 0 }}>
        Writes run directly or wait for approval depending on this team’s safety setting on the Define page.
      </p>
    </div>
  );
}

/** A compact two-state Read / Can-write toggle (segmented control, house styling). */
function AccessToggle({
  write, canEdit, onRead, onWrite,
}: {
  write: boolean;
  canEdit: boolean;
  onRead: () => void;
  onWrite: () => void;
}) {
  return (
    <span className="sb-access" role="group" aria-label="Access level" style={{ display: 'inline-flex', gap: 4 }}>
      <button
        type="button"
        className={`btn ghost sm${write ? '' : ' active'}`}
        aria-pressed={!write}
        disabled={!canEdit}
        onClick={() => canEdit && write && onRead()}
      >
        Read
      </button>
      <button
        type="button"
        className={`btn ghost sm${write ? ' active' : ''}`}
        aria-pressed={write}
        disabled={!canEdit}
        onClick={() => canEdit && !write && onWrite()}
      >
        Can write
      </button>
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
  systemId, system, kind, label, canEdit, onCommit,
}: {
  systemId: string;
  system: System;
  /** An id-carrying grant kind (Files is handled separately by FilesGrant). */
  kind: 'data' | 'knowledge' | 'connections';
  label: string;
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
    fetch(`/api/agents/systems/${systemId}/grants/available?kind=${kind}`, { cache: 'no-store' })
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? 'Failed to load');
        if (alive) setAvailable(body.items as Available[]);
      })
      .catch((e) => { if (alive) setLoadErr((e as Error).message); });
    return () => { alive = false; };
  }, [systemId, kind]);

  const granted = system.grants[kind];
  const availOf = (id: string) => available?.find((a) => a.id === id);
  const nameOf = (id: string) =>
    availOf(id)?.name
    ?? (id.includes('_') ? id.split('_').slice(1).join('_') : id);
  /** Built medallion layers for a granted dataset (empty until `available` loads). */
  const layersOf = (id: string): DataLayer[] => availOf(id)?.layers ?? [];
  const grantedIds = new Set(granted.map((g) => g.id));
  const addable = (available ?? []).filter((a) => !grantedIds.has(a.id));
  const q = search.trim().toLowerCase();
  const shown = q ? addable.filter((a) => a.name.toLowerCase().includes(q) || a.id.toLowerCase().includes(q)) : addable;
  const writes = (cap: string) => cap === 'Write-approval' || cap === 'Write-bounded';

  return (
    <div className="sb-resource">
      <div className="sb-field-label" style={{ margin: '4px 0' }}>{label}</div>
      {loadErr ? <div className="error" style={{ marginBottom: 6 }}>{loadErr}</div> : null}
      <div className="sb-chips">
        {granted.length === 0 ? <span className="hint" style={{ marginTop: 0 }}>None yet.</span> : null}
        {granted.map((g) => (
          <span key={g.id} className="sb-chip granted" style={{ gap: 8 }}>
            <span>{nameOf(g.id)}</span>
            <AccessToggle
              write={writes(g.capability)}
              canEdit={canEdit}
              onRead={() => onCommit(setArtifactGrant(system, kind, g.id, false))}
              onWrite={() => onCommit(setArtifactGrant(system, kind, g.id, true))}
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
      {kind === 'data' && granted.length > 0 ? (
        <p className="hint" style={{ marginTop: 4, marginBottom: 0 }}>
          Which refined layer this team reads — Gold is the curated default.
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
                      // DATA grants default to the HIGHEST built layer (Gold if built,
                      // else Silver, else Bronze); non-data kinds ignore the layer arg.
                      onCommit(setArtifactGrant(system, kind, a.id, false, highestLayer(a.layers) ?? 'gold'))
                    }
                  >
                    +<span>{a.name}</span><span className="badge muted">{a.scope}</span>
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

/**
 * Files grant — files carry NO per-artifact id list (file tools act over the caller's
 * own DLS), so this is a single Off / Read / Can-write control. State is derived from
 * whether the team's tool pool holds the file read/write tools (see capability-tools).
 */
function FilesGrant({
  system, canEdit, onCommit,
}: {
  system: System;
  canEdit: boolean;
  onCommit: (next: System) => void;
}) {
  const write = hasWriteTools(system, 'files');
  const on = write || system.grants.tools.includes('list_files');

  return (
    <div className="sb-resource">
      <div className="sb-field-label" style={{ margin: '4px 0' }}>Files</div>
      <div className="sb-chips" style={{ alignItems: 'center' }}>
        {on ? (
          <span className="sb-chip granted" style={{ gap: 8 }}>
            <span>Team files</span>
            <AccessToggle
              write={write}
              canEdit={canEdit}
              onRead={() => onCommit(setArtifactGrant(system, 'files', null, false))}
              onWrite={() => onCommit(setArtifactGrant(system, 'files', null, true))}
            />
          </span>
        ) : (
          <span className="hint" style={{ marginTop: 0 }}>None yet.</span>
        )}
      </div>
      {canEdit && !on ? (
        <button className="btn ghost sm" style={{ marginTop: 6 }} onClick={() => onCommit(setArtifactGrant(system, 'files', null, false))}>
          + Give file access
        </button>
      ) : null}
      {canEdit && write ? (
        <p className="hint" style={{ marginTop: 4, marginBottom: 0 }}>
          File read tools stay granted; switch back to <strong>Read</strong> to drop write. Full removal lives in Developer mode.
        </p>
      ) : null}
    </div>
  );
}
