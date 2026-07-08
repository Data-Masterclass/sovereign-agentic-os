/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useApi } from '@/lib/useApi';
import AgentEditor from './AgentEditor';
import GrantsRouting from './GrantsRouting';
import BuildRunPanel from './BuildRunPanel';
import MonacoFile from './MonacoFile';
import RuntimeSelector from './RuntimeSelector';
import { commitSystem } from './commitSystem';
import { addAgent, addHandoffEdge, addSuperviseEdge, removeAgent, removeEdge, setEntrypoint, setNodePositions } from '@/lib/agents/canvas-edit';
import type { Schedule, System } from '@/lib/agents/system-schema';
import type { ModelInfo } from '@/lib/agents/routing';
import { roleAtLeast, type Role } from '@/lib/session';
import LifecycleActions from '@/components/lifecycle/LifecycleActions';
import { ConfirmProvider } from '@/components/lifecycle/ConfirmDialog';
import type { Visibility } from '@/lib/lifecycle';
import DomainTag from '@/components/DomainTag';

// React Flow + Monaco are heavy, client-only, and SSR-tolerant only when lazy —
// load the canvas ssr:false (same pattern as MonacoFile) so the standalone build
// stays clean and offline. Its CSS is imported locally inside the component.
const GraphCanvas = dynamic(() => import('./GraphCanvas'), {
  ssr: false,
  loading: () => <div className="gc-loading"><span className="spin" /> Loading canvas…</div>,
});

/**
 * Level 2 — the system canvas + the three interchangeable editors over the one
 * source (canvas · Monaco system.yaml · agent-system chat) plus Build/verify,
 * run/schedule/toggle, system grants + routing, and the Level-3 agent editor. A
 * supervise/handoff connection is decided by topology (entrypoint/supervisor →
 * supervise, otherwise handoff) and committed as a system.yaml diff.
 */

type LastBuildRow = { tool: string; applied: boolean; verified: boolean; status: 'ok' | 'fail'; detail: string; error?: string };
type LastBuild = { ok: boolean; at: number; rows: LastBuildRow[] };

type SystemViewData = {
  id: string;
  name: string;
  domain: string;
  owner: string;
  visibility: 'Personal' | 'Shared' | 'Marketplace';
  origin: 'authored' | 'forked';
  running: boolean;
  schedule: Schedule;
  disabledAgents: string[];
  lastActivity: string | null;
  lastBuild: LastBuild | null;
  system: System;
  ir: unknown;
  compileError: string | null;
  canEdit: boolean;
  role: Role;
  hermesEnabled: boolean;
  /** Soft-archived (retained, reversible). Absent/false = live. */
  archived?: boolean;
};

type ModelsData = { models: ModelInfo[]; source: 'litellm' | 'offline'; roles?: { reasoning: string; standard: string; embeddings: string } };
type RoutingData = { activities: string[]; tiers: Record<string, string>; table: Record<string, { tier: string; model: string }> };

type Panel = 'yaml' | 'grants' | 'build';

const visClass = (v: string) => (v === 'Shared' ? 'vis-shared' : v === 'Marketplace' ? 'vis-certified' : 'vis-personal');

/** Systems visibility → the OS-wide lifecycle visibility (drives the delete gate). */
const lcVis = (v: SystemViewData['visibility']): Visibility =>
  v === 'Shared' ? 'shared' : v === 'Marketplace' ? 'certified' : 'personal';

export default function SystemView({ systemId, onBack }: { systemId: string; onBack: () => void }) {
  const { data, loading, error, reload } = useApi<SystemViewData>(`/api/agents/systems/${systemId}`);
  const { data: modelsData } = useApi<ModelsData>('/api/agents/models');
  const { data: routingData } = useApi<RoutingData>('/api/agents/routing');

  const [panel, setPanel] = useState<Panel>('yaml');
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [actErr, setActErr] = useState('');
  const [acting, setActing] = useState(false);
  // Re-entry guard: state is async, so gate concurrent edits through a ref. This
  // serializes mutations so each one builds its diff from the freshly-reloaded
  // source — no stale-base lost update on rapid canvas/chip edits.
  const actingRef = useRef(false);
  // Bounded undo/redo over committed System snapshots. A structural edit pushes the
  // pre-edit doc; undo re-commits it. Position drags skip history (skipHistory) so
  // undo means "undo a real change", not "un-nudge a node".
  const currentSysRef = useRef<System | null>(null);
  const undoRef = useRef<System[]>([]);
  const redoRef = useRef<System[]>([]);

  const reloadAll = useCallback(async () => {
    await reload();
    setReloadKey((k) => k + 1);
  }, [reload]);

  const models = modelsData?.models ?? [];

  const commit = useCallback(
    async (next: System, opts?: { skipHistory?: boolean; snapshot?: System | null }) => {
      if (actingRef.current) return;
      actingRef.current = true;
      setActing(true);
      setActErr('');
      try {
        if (!opts?.skipHistory) {
          const snap = opts?.snapshot ?? currentSysRef.current;
          if (snap) {
            undoRef.current = [...undoRef.current.slice(-29), snap];
            redoRef.current = [];
          }
        }
        await commitSystem(systemId, next);
        await reloadAll();
      } catch (e) {
        setActErr((e as Error).message);
      } finally {
        actingRef.current = false;
        setActing(false);
      }
    },
    [systemId, reloadAll],
  );

  // Back-compat alias: existing callers pass a full next System (structural edit).
  const mutate = useCallback((next: System) => commit(next), [commit]);

  const undo = useCallback(() => {
    const prev = undoRef.current.pop();
    if (!prev || !currentSysRef.current) return;
    redoRef.current = [...redoRef.current.slice(-29), currentSysRef.current];
    void commit(prev, { skipHistory: true });
  }, [commit]);

  const redo = useCallback(() => {
    const next = redoRef.current.pop();
    if (!next || !currentSysRef.current) return;
    undoRef.current = [...undoRef.current.slice(-29), currentSysRef.current];
    void commit(next, { skipHistory: true });
  }, [commit]);

  // Keyboard undo/redo — ignored while typing in a field or the Monaco editor.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable || t.closest('.monaco-editor'))) return;
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  const post = useCallback(
    async (path: string, body?: unknown) => {
      if (actingRef.current) return;
      actingRef.current = true;
      setActing(true);
      setActErr('');
      try {
        const res = await fetch(`/api/agents/systems/${systemId}/${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined,
        });
        const b = await res.json();
        if (!res.ok) throw new Error(b.error ?? 'Action failed');
        await reloadAll();
      } catch (e) {
        setActErr((e as Error).message);
      } finally {
        actingRef.current = false;
        setActing(false);
      }
    },
    [systemId, reloadAll],
  );

  if (loading && !data) return <div className="stub-page"><span className="spin" /> Loading system…</div>;
  if (error) return (
    <>
      <button className="btn ghost sm" onClick={onBack}>← All systems</button>
      <div className="error" style={{ marginTop: 12 }}>{error}</div>
    </>
  );
  if (!data) return null;

  const sys = data.system;
  currentSysRef.current = sys; // keep the undo/redo baseline in sync with the source
  // Promotion ladder (Level 1 spec): Personal ─(Builder+)─▶ Shared ─(Admin)─▶
  // Marketplace. The gate is enforced server-side in promoteSystem; here we only
  // SHOW the affordance to an eligible owner/admin so a click never 403s. Forked
  // (installed) copies and already-Marketplace systems have no next rung.
  const canPromote =
    data.canEdit &&
    data.origin !== 'forked' &&
    ((data.visibility === 'Personal' && roleAtLeast(data.role, 'builder')) ||
      (data.visibility === 'Shared' && data.role === 'admin'));
  const promoteLabel = data.visibility === 'Personal' ? 'Promote to Shared' : 'Publish to Marketplace';
  const editable = data.canEdit && !acting;
  const onConnect = (from: string, to: string) => {
    const fromAgent = sys.agents.find((a) => a.id === from);
    const isSupervisor = from === sys.entrypoint || (fromAgent?.members?.length ?? 0) > 0;
    void mutate(isSupervisor ? addSuperviseEdge(sys, from, to) : addHandoffEdge(sys, from, to));
  };
  // Guided add: auto-name the next agent and open its drawer immediately. The FIRST
  // agent auto-becomes the START (entrypoint) so a fresh system compiles at once.
  const addAgentGuided = () => {
    const ids = new Set(sys.agents.map((a) => a.id));
    let n = sys.agents.length + 1;
    let id = `agent${n}`;
    while (ids.has(id)) { n += 1; id = `agent${n}`; }
    let next = addAgent(sys, { id });
    if (!next.entrypoint) next = setEntrypoint(next, id);
    void commit(next, { snapshot: sys }).then(() => setSelectedAgent(id));
  };

  return (
    <ConfirmProvider>
    <div className="system-view">
      <div className="system-head">
        <button className="btn ghost sm" onClick={onBack}>← All systems</button>
        <div className="system-title-block">
          <span className="system-title">{data.name}</span>
          {(data.visibility === 'Shared' || data.visibility === 'Marketplace') ? <DomainTag domain={data.domain} /> : null}
          <span className={`badge ${visClass(data.visibility)}`}>{data.visibility}</span>
          {data.origin === 'forked' ? <span className="badge muted">forked copy</span> : null}
          <span className={`badge ${data.running ? 'ok' : 'muted'}`}>{data.running ? 'running' : 'stopped'}</span>
          {data.schedule.kind !== 'manual' ? <span className="badge warn">{data.schedule.kind}</span> : null}
          {!data.canEdit ? <span className="badge muted">read-only</span> : null}
        </div>
        <div className="system-actions">
          {acting ? <span className="spin" title="applying…" /> : null}
          {data.running ? (
            <button className="btn ghost sm" onClick={() => post('run', { stop: true })} disabled={!data.canEdit || acting}>Stop</button>
          ) : (
            <button className="btn sm" onClick={() => post('run', { prompt: 'Test invocation' })} disabled={!data.canEdit || acting}>Run</button>
          )}
          <ScheduleControl systemId={systemId} schedule={data.schedule} canEdit={data.canEdit && !acting} onSaved={reloadAll} />
          {canPromote ? (
            <button className="btn ghost sm" onClick={() => post('promote')} disabled={acting} title={`Governed publish step — ${promoteLabel}`}>
              {promoteLabel}
            </button>
          ) : null}
          {/* OS-wide rule: live → Archive; only an ARCHIVED system exposes Delete.
              Real archived state drives which actions show. */}
          {data.canEdit ? (
            <LifecycleActions
              id={data.id}
              name={data.name}
              kind="agent"
              visibility={lcVis(data.visibility)}
              archived={!!data.archived}
              api={`/api/agents/systems/${systemId}`}
              onChanged={() => { if (data.archived) onBack(); else void reloadAll(); }}
              showVersions={false}
              compact
            />
          ) : null}
        </div>
      </div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
        domain <span className="mono">{data.domain}</span> · owner <span className="mono">{data.owner}</span>
        {data.lastActivity ? <> · last activity {new Date(data.lastActivity).toLocaleString()}</> : null}
      </div>

      <RuntimeSelector
        system={sys}
        canEdit={data.canEdit && !acting}
        hermesEnabled={data.hermesEnabled}
        onChange={(next) => mutate(next)}
      />

      {actErr ? <div className="error" style={{ marginBottom: 12 }}>{actErr}</div> : null}

      <BuildChecklist system={sys} compileError={data.compileError} disabledAgents={data.disabledAgents} />

      <GraphCanvas
        system={sys}
        disabledAgents={data.disabledAgents}
        selectedId={selectedAgent}
        canEdit={editable}
        compileError={data.compileError}
        syncKey={reloadKey}
        onSelectAgent={(id) => setSelectedAgent(id)}
        onConnect={onConnect}
        onRemoveEdge={(from, to, type) => mutate(removeEdge(sys, { from, to, type }))}
        onRemoveAgent={(id) => { if (selectedAgent === id) setSelectedAgent(null); void mutate(removeAgent(sys, id)); }}
        onMoveNodes={(positions) => commit(setNodePositions(sys, positions), { skipHistory: true })}
        onAddAgent={addAgentGuided}
        onUndo={undo}
        onRedo={redo}
        canUndo={undoRef.current.length > 0}
        canRedo={redoRef.current.length > 0}
      />

      {sys.agents.length > 0 ? (
        <div className="agent-chips">
          <span className="agent-chips-label">In the running system:</span>
          {sys.agents.map((a) => {
            const off = data.disabledAgents.includes(a.id);
            return (
              <div key={a.id} className={`agent-chip${off ? ' off' : ''}${selectedAgent === a.id ? ' sel' : ''}`}>
                <button className="agent-chip-name" onClick={() => setSelectedAgent(a.id)}>
                  {a.id}{a.id === sys.entrypoint ? ' ★' : ''}
                </button>
                {data.canEdit && a.id !== sys.entrypoint ? (
                  <button
                    className={`switch sm${off ? '' : ' on'}`}
                    title={off ? 'Enable in the running system' : 'Disable in the running system'}
                    disabled={acting}
                    onClick={() => post('toggle', { agentId: a.id, on: off })}
                  >
                    <span className="switch-track"><span className="switch-thumb" /></span>
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}

      <div className="tabstrip" style={{ marginTop: 18 }}>
        <button className={panel === 'yaml' ? 'active' : ''} onClick={() => setPanel('yaml')}>system.yaml</button>
        <button className={panel === 'grants' ? 'active' : ''} onClick={() => setPanel('grants')}>Grants &amp; routing</button>
        <button className={panel === 'build' ? 'active' : ''} onClick={() => setPanel('build')}>Build &amp; run</button>
      </div>

      <div style={{ marginTop: 14 }}>
        {panel === 'yaml' ? (
          <MonacoFile systemId={systemId} path="system.yaml" canEdit={data.canEdit} height={420} reloadSignal={reloadKey} onSaved={reloadAll} />
        ) : null}
        {panel === 'grants' ? (
          <GrantsRouting systemId={systemId} system={sys} canEdit={data.canEdit} canDirectWrite={roleAtLeast(data.role, 'builder')} models={models} routing={routingData} onChanged={reloadAll} />
        ) : null}
        {panel === 'build' ? (
          <BuildRunPanel systemId={systemId} running={data.running} canEdit={data.canEdit} lastBuild={data.lastBuild} onStateChange={reloadAll} />
        ) : null}
      </div>

      {/* Right slide-in config drawer — the canvas + tabs stay visible behind it. */}
      {selectedAgent ? (
        <div className="agent-drawer-scrim" onClick={() => setSelectedAgent(null)}>
          <aside className="agent-drawer" onClick={(e) => e.stopPropagation()}>
            <AgentEditor
              systemId={systemId}
              system={sys}
              agentId={selectedAgent}
              canEdit={data.canEdit}
              roles={{
                reasoning: modelsData?.roles?.reasoning || 'sovereign-reasoning',
                standard: modelsData?.roles?.standard || 'sovereign-default',
              }}
              isEntrypoint={selectedAgent === sys.entrypoint}
              onSetEntrypoint={editable ? () => void commit(setEntrypoint(sys, selectedAgent), { snapshot: sys }) : undefined}
              onChanged={reloadAll}
              onClose={() => setSelectedAgent(null)}
            />
          </aside>
        </div>
      ) : null}
    </div>
    </ConfirmProvider>
  );
}

/**
 * A Dify-style pre-build checklist. Green when the graph compiles; otherwise it
 * surfaces the exact blocker (from the server-side compile) as a to-fix item so a
 * non-technical builder knows what to do before Run/Build.
 */
function BuildChecklist({ system, compileError, disabledAgents }: { system: System; compileError: string | null; disabledAgents: string[] }) {
  const items: { ok: boolean; text: string }[] = [];
  items.push({ ok: system.agents.length > 0, text: system.agents.length > 0 ? `${system.agents.length} agent${system.agents.length === 1 ? '' : 's'}` : 'Add at least one agent' });
  items.push({ ok: !!system.entrypoint, text: system.entrypoint ? `START · ${system.entrypoint}` : 'Set a START agent' });
  const activeCount = system.agents.filter((a) => !disabledAgents.includes(a.id)).length;
  if (disabledAgents.length > 0) items.push({ ok: activeCount > 0, text: `${activeCount} active in run` });
  if (compileError) items.push({ ok: false, text: compileError });
  const ready = !compileError && system.agents.length > 0 && !!system.entrypoint;
  return (
    <div className={`gc-checklist${ready ? ' ready' : ''}`}>
      <span className={`gc-check-dot ${ready ? 'ok' : 'warn'}`} />
      <span className="gc-check-title">{ready ? 'Ready to build' : 'Before you build'}</span>
      <span className="gc-check-items">
        {items.map((it, i) => (
          <span key={i} className={`gc-check-item ${it.ok ? 'ok' : 'todo'}`}>
            {it.ok ? '✓' : '•'} {it.text}
          </span>
        ))}
      </span>
    </div>
  );
}

type CronStatus = { ok: boolean; live: boolean; action: string; detail: string; name: string };

function ScheduleControl({ systemId, schedule, canEdit, onSaved }: { systemId: string; schedule: Schedule; canEdit: boolean; onSaved: () => void | Promise<void> }) {
  // Local optimistic mirrors of the server-owned schedule so the dropdown reflects
  // the choice immediately (no snap-back during the round-trip) and the cron field
  // re-syncs when the persisted value changes.
  const [kind, setKind] = useState<Schedule['kind']>(schedule.kind);
  const [cron, setCron] = useState(schedule.cron ?? '0 9 * * 1');
  const [busy, setBusy] = useState(false);
  // The CronJob reconcile status (honest): a cron schedule only fires once a real
  // CronJob is provisioned — surface when it was NOT (e.g. cluster unreachable).
  const [cronStatus, setCronStatus] = useState<CronStatus | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { setKind(schedule.kind); }, [schedule.kind]);
  useEffect(() => { if (schedule.cron) setCron(schedule.cron); }, [schedule.cron]);

  const save = async (next: Schedule) => {
    setBusy(true);
    setErr('');
    setCronStatus(null);
    try {
      const res = await fetch(`/api/agents/systems/${systemId}/schedule`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(next),
      });
      const b = await res.json();
      if (!res.ok) throw new Error(b.error ?? 'Schedule update failed');
      if (b.cron) setCronStatus(b.cron as CronStatus);
      await onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
      <div className="row" style={{ gap: 6, alignItems: 'center' }}>
        <select
          value={kind}
          disabled={!canEdit || busy}
          onChange={(e) => {
            const next = e.target.value as Schedule['kind'];
            setKind(next);
            void save(next === 'cron' ? { kind: next, cron } : next === 'event' ? { kind: next, event: 'on_demand' } : { kind: next });
          }}
          title="Schedule"
        >
          <option value="manual">manual</option>
          <option value="cron">cron</option>
          <option value="event">event</option>
        </select>
        {kind === 'cron' ? (
          <form onSubmit={(e) => { e.preventDefault(); void save({ kind: 'cron', cron }); }}>
            <input type="text" value={cron} onChange={(e) => setCron(e.target.value)} disabled={!canEdit || busy} style={{ width: 120 }} className="mono" />
          </form>
        ) : null}
      </div>
      {err ? <span className="muted" style={{ fontSize: 11, color: 'var(--danger, #c0392b)' }}>{err}</span> : null}
      {cronStatus && kind === 'cron' && !cronStatus.ok ? (
        <span className="muted" style={{ fontSize: 11, color: 'var(--warn, #b7791f)' }} title={cronStatus.detail}>
          ⚠ schedule saved but not scheduled — {cronStatus.detail}
        </span>
      ) : null}
      {cronStatus && kind === 'cron' && cronStatus.ok && cronStatus.live ? (
        <span className="muted" style={{ fontSize: 11 }}>✓ CronJob {cronStatus.action} — runs on schedule</span>
      ) : null}
    </div>
  );
}
