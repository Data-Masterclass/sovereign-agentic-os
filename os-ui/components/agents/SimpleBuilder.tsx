/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import BuildRunPanel from './BuildRunPanel';
import { commitSystem } from './commitSystem';
import type { System } from '@/lib/agents/system-schema';
import { classifyModelNeed } from '@/lib/agents/routing';
import { instructionsOf } from '@/lib/agents/agent-md';
import {
  addSimpleAgent, moveAgent, removeAgentSimple,
  setAgentInstructions, setAgentRole, addArtifactGrant, removeArtifactGrant,
  addAgentTool, removeAgentTool,
} from '@/lib/agents/simple-edit';
import { setEntrypoint } from '@/lib/agents/canvas-edit';
import { suggestTools } from '@/lib/agents/suggest-tools';

/**
 * Simple mode — the guided, linear builder for non-coders. It reads and writes the
 * SAME `system.yaml` / `agents/<id>/AGENT.md` Developer mode does, through the
 * SAME `commitSystem` file write and `/api/agents` endpoints. There is NO parallel
 * data model: every action here (describe→scaffold, edit a plain field, accept a
 * suggested tool, add/remove/reorder an agent) is an ordinary edit to the one
 * source of truth, so flipping to Developer mode shows exactly what Simple made.
 *
 * The flow is a plain ordered path — Describe · Name · Agents · Build · Run — not a
 * canvas and never Monaco. Build/Run reuse the existing BuildRunPanel unchanged.
 */

type Step = 'name' | 'agents' | 'run';

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
  const [step, setStep] = useState<Step>('name');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const editable = canEdit && !busy;
  const hasAgents = system.agents.length > 0;
  const ready = hasAgents && !!system.entrypoint;

  // Advance to the Agents step automatically once the system has agents (e.g. after
  // a scaffold or the first add) — but never yank a user who stepped back.
  const autoAdvanced = useRef(false);
  useEffect(() => {
    if (hasAgents && !autoAdvanced.current) { autoAdvanced.current = true; setStep('agents'); }
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

  return (
    <div className="simple-builder">
      <ol className="sb-steps" aria-label="Build steps">
        {(['name', 'agents', 'run'] as Step[]).map((s, i) => {
          const label = s === 'name' ? 'Describe & name' : s === 'agents' ? 'Your team' : 'Build & run';
          const done = s === 'name' ? !!system.system.name : s === 'agents' ? ready : false;
          return (
            <li key={s} className={`sb-step${step === s ? ' active' : ''}${done ? ' done' : ''}`}>
              <button type="button" onClick={() => setStep(s)} disabled={s === 'run' && !ready}>
                <span className="sb-step-n">{done ? '✓' : i + 1}</span>
                <span className="sb-step-label">{label}</span>
              </button>
            </li>
          );
        })}
      </ol>

      {err ? <div className="error" style={{ marginBottom: 12 }}>{err}</div> : null}

      {step === 'name' ? (
        <DescribeAndName
          systemId={systemId}
          system={system}
          canEdit={editable}
          onScaffolded={async () => { await onReload(); setStep('agents'); }}
          onRenamed={(next) => commit(next)}
          onNext={() => setStep('agents')}
        />
      ) : null}

      {step === 'agents' ? (
        <AgentsStep
          systemId={systemId}
          system={system}
          canEdit={editable}
          catalog={catalog}
          onCommit={commit}
          onBack={() => setStep('name')}
          onNext={() => ready && setStep('run')}
          ready={ready}
        />
      ) : null}

      {step === 'run' ? (
        <div className="sb-run">
          <p className="hint" style={{ marginTop: 0 }}>
            Build compiles your team and checks it. Run walks the team from the start agent and shows
            every step. This is the same engine developers use — nothing is hidden.
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
          />
          <button className="btn ghost sm" style={{ marginTop: 12 }} onClick={() => setStep('agents')}>← Back to your team</button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Step 1 — the HERO. A prominent "Describe what your team should do" box that runs
 * the EXISTING scaffold path (the assistant endpoint that edits system.yaml), plus
 * a plain Name field. After scaffolding the caller advances to the review step.
 */
function DescribeAndName({
  systemId,
  system,
  canEdit,
  onScaffolded,
  onRenamed,
  onNext,
}: {
  systemId: string;
  system: System;
  canEdit: boolean;
  onScaffolded: () => Promise<void> | void;
  onRenamed: (next: System) => void;
  onNext: () => void;
}) {
  const [desc, setDesc] = useState('');
  const [name, setName] = useState(system.system.name === 'Untitled system' ? '' : system.system.name);
  const [scaffolding, setScaffolding] = useState(false);
  const [scaffoldErr, setScaffoldErr] = useState('');
  const hasAgents = system.agents.length > 0;

  // Persist a name edit on blur (an ordinary system.yaml edit through the shared path).
  const saveName = () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === system.system.name) return;
    onRenamed({ ...system, system: { ...system.system, name: trimmed } });
  };

  const describe = async () => {
    const instruction = desc.trim();
    if (!instruction || scaffolding) return;
    setScaffolding(true);
    setScaffoldErr('');
    try {
      // The SAME scaffold endpoint HelperChat uses — edits system.yaml server-side.
      const res = await fetch(`/api/agents/systems/${systemId}/assistant`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ instruction }),
      });
      const raw = await res.text();
      let body: { error?: string; summary?: string } = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
      if (!res.ok) { setScaffoldErr(body.error ?? 'The OS could not build that yet.'); return; }
      setDesc('');
      await onScaffolded();
    } catch (e) {
      setScaffoldErr((e as Error).message);
    } finally {
      setScaffolding(false);
    }
  };

  return (
    <div className="sb-describe">
      <div className="sb-hero">
        <h2 className="sb-hero-title">Describe what your team should do</h2>
        <p className="sb-hero-sub">
          Say it in plain words — the OS builds the agents, wires them up, and picks the right model
          for each. You review and adjust next.
        </p>
        <textarea
          className="sb-hero-input"
          rows={3}
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          disabled={!canEdit || scaffolding}
          placeholder="e.g. a team that pulls campaign data, checks margins after returns, scores each campaign against the rules, and recommends budget changes"
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void describe(); } }}
        />
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginTop: 10 }}>
          <span className="hint" style={{ marginTop: 0 }}>⌘/Ctrl + Enter. Governed like every agent.</span>
          <button className="btn" onClick={describe} disabled={!canEdit || scaffolding || !desc.trim()}>
            {scaffolding ? <span className="spin" /> : hasAgents ? 'Add to my team' : 'Build my team'}
          </button>
        </div>
        {scaffoldErr ? <div className="error" style={{ marginTop: 10 }}>{scaffoldErr}</div> : null}
      </div>

      <div className="sb-name-row">
        <label className="sb-field-label" htmlFor="sb-name">Name your team</label>
        <input
          id="sb-name"
          type="text"
          value={name}
          disabled={!canEdit}
          onChange={(e) => setName(e.target.value)}
          onBlur={saveName}
          onKeyDown={(e) => { if (e.key === 'Enter') { saveName(); onNext(); } }}
          placeholder="e.g. Renewals desk"
        />
      </div>

      {hasAgents ? (
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 4 }}>
          <button className="btn ghost sm" onClick={() => { saveName(); onNext(); }}>Review your team →</button>
        </div>
      ) : (
        <p className="hint">Or start empty and add agents yourself on the next step.</p>
      )}
    </div>
  );
}

/**
 * Step 2 — plain per-agent cards. Each agent is a card with a Role field, an
 * Instructions textarea (mapped losslessly to AGENT.md), the resolved Auto model
 * tier, and accept/toggle tool chips (deterministic suggestions). Add/remove/
 * reorder edit system.yaml directly. No Monaco, no canvas.
 */
function AgentsStep({
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

      <button
        className="btn ghost sm sb-add"
        disabled={!canEdit}
        onClick={() => onCommit(addSimpleAgent(system, {}))}
      >
        + Add an agent
      </button>

      <div className="row" style={{ justifyContent: 'space-between', marginTop: 18 }}>
        <button className="btn ghost sm" onClick={onBack}>← Describe</button>
        <button className="btn" onClick={onNext} disabled={!ready} title={ready ? 'Build & run' : 'Add at least one agent first'}>
          Build &amp; run →
        </button>
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

  // Local mirrors for the plain fields so typing is smooth; committed on blur.
  const [role, setRole] = useState(agent.role);
  const [instr, setInstr] = useState(() => instructionsOf(agent.agent_md));
  useEffect(() => { setRole(agent.role); }, [agent.role]);
  useEffect(() => { setInstr(instructionsOf(agent.agent_md)); }, [agent.agent_md]);

  // The tools this agent effectively sees (inherits the system grants unless narrowed).
  const effectiveTools = agent.tools ?? system.grants.tools;

  // Deterministic suggestions from the role + instructions, minus what THIS agent
  // already has (effectiveTools) — not the system pool, so a tool granted to a
  // sibling is still offered here.
  const suggestions = useMemo(() => {
    const text = `${agent.id} ${role} ${instr}`;
    return suggestTools(text, catalog ?? undefined).filter((s) => !effectiveTools.includes(s.tool));
  }, [agent.id, role, instr, catalog, effectiveTools]);

  // The Auto model tier this agent resolves to (same classifier the run uses).
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

      {/* Granted tools (chips) — removable; plus accept-chips for suggestions. */}
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

type Available = { id: string; name: string; scope: 'personal' | 'domain' | 'marketplace' };

/**
 * Simple-mode "What your team can use" — the plain Data + Knowledge grant chips.
 * These are SYSTEM-level grants (all agents share them), written to the same
 * `grants.data` / `grants.knowledge` the Developer Grants panel writes, at Read
 * access. Write access and Metrics/Connections stay in Developer mode so Simple
 * stays uncluttered — but a non-coder can now attach the data and knowledge a team
 * needs without leaving the guided flow.
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
        Give the whole team read access to the data and knowledge it needs — every agent shares these.
        Write access and finer control live in Developer mode.
      </p>
      <ResourcePicker systemId={systemId} system={system} field="data" label="Data" canEdit={canEdit} onCommit={onCommit} />
      <ResourcePicker systemId={systemId} system={system} field="knowledge" label="Knowledge" canEdit={canEdit} onCommit={onCommit} />
    </div>
  );
}

/**
 * One artifact kind (data or knowledge): granted chips + an add-picker sourced from
 * the SAME role-scoped `…/grants/available?kind=` endpoint the Developer grants
 * table uses. Add grants at Read; remove is idempotent. Names come from the
 * available list, falling back to a short id so nothing shows a raw machine id.
 */
function ResourcePicker({
  systemId, system, field, label, canEdit, onCommit,
}: {
  systemId: string;
  system: System;
  field: 'data' | 'knowledge';
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
    fetch(`/api/agents/systems/${systemId}/grants/available?kind=${field}`, { cache: 'no-store' })
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? 'Failed to load');
        if (alive) setAvailable(body.items as Available[]);
      })
      .catch((e) => { if (alive) setLoadErr((e as Error).message); });
    return () => { alive = false; };
  }, [systemId, field]);

  const granted = system.grants[field];
  const nameOf = (id: string) =>
    available?.find((a) => a.id === id)?.name
    ?? (id.includes('_') ? id.split('_').slice(1).join('_') : id);
  const grantedIds = new Set(granted.map((g) => g.id));
  const addable = (available ?? []).filter((a) => !grantedIds.has(a.id));
  const q = search.trim().toLowerCase();
  const shown = q ? addable.filter((a) => a.name.toLowerCase().includes(q) || a.id.toLowerCase().includes(q)) : addable;

  return (
    <div className="sb-resource">
      <div className="sb-field-label" style={{ margin: '4px 0' }}>{label}</div>
      {loadErr ? <div className="error" style={{ marginBottom: 6 }}>{loadErr}</div> : null}
      <div className="sb-chips">
        {granted.length === 0 ? <span className="hint" style={{ marginTop: 0 }}>None yet.</span> : null}
        {granted.map((g) => (
          <span key={g.id} className="sb-chip granted">
            <span>{nameOf(g.id)}</span>
            {canEdit ? (
              <button className="sb-chip-x" title="Remove" onClick={() => onCommit(removeArtifactGrant(system, field, g.id))}>✕</button>
            ) : null}
          </span>
        ))}
      </div>
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
                    onClick={() => onCommit(addArtifactGrant(system, field, a.id))}
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
