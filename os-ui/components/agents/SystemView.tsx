/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useApi } from '@/lib/useApi';
import SystemCanvas from './SystemCanvas';
import AgentEditor from './AgentEditor';
import GrantsRouting from './GrantsRouting';
import BuildRunPanel from './BuildRunPanel';
import HelperChat from './HelperChat';
import MonacoFile from './MonacoFile';
import { commitSystem } from './commitSystem';
import { addAgent, addHandoffEdge, addSuperviseEdge, removeEdge } from '@/lib/agents/canvas-edit';
import type { Schedule, System } from '@/lib/agents/system-schema';

/**
 * Level 2 — the system canvas + the three interchangeable editors over the one
 * source (canvas · Monaco system.yaml · agent-system chat) plus Build/verify,
 * run/schedule/toggle, system grants + routing, and the Level-3 agent editor. A
 * supervise/handoff connection is decided by topology (entrypoint/supervisor →
 * supervise, otherwise handoff) and committed as a system.yaml diff.
 */

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
  system: System;
  ir: unknown;
  compileError: string | null;
  canEdit: boolean;
  role: string;
};

type ModelsData = { models: string[]; source: 'litellm' | 'offline' };
type RoutingData = { activities: string[]; tiers: Record<string, string>; table: Record<string, { tier: string; model: string }> };

type Panel = 'yaml' | 'grants' | 'build' | 'helper';

const visClass = (v: string) => (v === 'Shared' ? 'vis-shared' : v === 'Marketplace' ? 'vis-certified' : 'vis-personal');

export default function SystemView({ systemId, onBack }: { systemId: string; onBack: () => void }) {
  const { data, loading, error, reload } = useApi<SystemViewData>(`/api/agents/systems/${systemId}`);
  const { data: modelsData } = useApi<ModelsData>('/api/agents/models');
  const { data: routingData } = useApi<RoutingData>('/api/agents/routing');

  const [panel, setPanel] = useState<Panel>('yaml');
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [actErr, setActErr] = useState('');
  const [newAgentId, setNewAgentId] = useState('');
  const [acting, setActing] = useState(false);
  // Re-entry guard: state is async, so gate concurrent edits through a ref. This
  // serializes mutations so each one builds its diff from the freshly-reloaded
  // source — no stale-base lost update on rapid canvas/chip edits.
  const actingRef = useRef(false);

  const reloadAll = useCallback(async () => {
    await reload();
    setReloadKey((k) => k + 1);
  }, [reload]);

  const models = modelsData?.models ?? [];

  const mutate = useCallback(
    async (next: System) => {
      if (actingRef.current) return;
      actingRef.current = true;
      setActing(true);
      setActErr('');
      try {
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
  const onConnect = (from: string, to: string) => {
    const fromAgent = sys.agents.find((a) => a.id === from);
    const isSupervisor = from === sys.entrypoint || (fromAgent?.members?.length ?? 0) > 0;
    void mutate(isSupervisor ? addSuperviseEdge(sys, from, to) : addHandoffEdge(sys, from, to));
  };

  return (
    <div className="system-view">
      <div className="system-head">
        <button className="btn ghost sm" onClick={onBack}>← All systems</button>
        <div className="system-title-block">
          <span className="system-title">{data.name}</span>
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
          <ScheduleControl schedule={data.schedule} canEdit={data.canEdit && !acting} onSet={(s) => post('schedule', s)} />
        </div>
      </div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
        domain <span className="mono">{data.domain}</span> · owner <span className="mono">{data.owner}</span>
        {data.lastActivity ? <> · last activity {new Date(data.lastActivity).toLocaleString()}</> : null}
      </div>

      {actErr ? <div className="error" style={{ marginBottom: 12 }}>{actErr}</div> : null}

      <SystemCanvas
        system={sys}
        disabledAgents={data.disabledAgents}
        selectedId={selectedAgent}
        canEdit={data.canEdit && !acting}
        compileError={data.compileError}
        onSelectAgent={(id) => { setSelectedAgent(id); }}
        onConnect={onConnect}
        onRemoveEdge={(from, to, type) => mutate(removeEdge(sys, { from, to, type }))}
      />

      <div className="agent-chips">
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
        {data.canEdit ? (
          <form
            className="row"
            style={{ gap: 6, alignItems: 'center' }}
            onSubmit={(e) => { e.preventDefault(); if (newAgentId.trim()) { void mutate(addAgent(sys, { id: newAgentId.trim() })); setNewAgentId(''); } }}
          >
            <input type="text" value={newAgentId} onChange={(e) => setNewAgentId(e.target.value)} placeholder="new agent id" style={{ width: 130 }} />
            <button className="btn ghost sm" type="submit" disabled={!newAgentId.trim() || acting}>+ Agent</button>
          </form>
        ) : null}
      </div>

      {selectedAgent ? (
        <AgentEditor
          systemId={systemId}
          system={sys}
          agentId={selectedAgent}
          canEdit={data.canEdit}
          models={models}
          modelsSource={modelsData?.source ?? null}
          onChanged={reloadAll}
          onClose={() => setSelectedAgent(null)}
        />
      ) : (
        <>
          <div className="tabstrip" style={{ marginTop: 18 }}>
            <button className={panel === 'yaml' ? 'active' : ''} onClick={() => setPanel('yaml')}>system.yaml</button>
            <button className={panel === 'grants' ? 'active' : ''} onClick={() => setPanel('grants')}>Grants &amp; routing</button>
            <button className={panel === 'build' ? 'active' : ''} onClick={() => setPanel('build')}>Build &amp; run</button>
            <button className={panel === 'helper' ? 'active' : ''} onClick={() => setPanel('helper')}>Agent-system helper</button>
          </div>

          <div style={{ marginTop: 14 }}>
            {panel === 'yaml' ? (
              <MonacoFile systemId={systemId} path="system.yaml" canEdit={data.canEdit} height={420} reloadSignal={reloadKey} onSaved={reloadAll} />
            ) : null}
            {panel === 'grants' ? (
              <GrantsRouting systemId={systemId} system={sys} canEdit={data.canEdit} models={models} routing={routingData} onChanged={reloadAll} />
            ) : null}
            {panel === 'build' ? (
              <BuildRunPanel systemId={systemId} running={data.running} canEdit={data.canEdit} onStateChange={reloadAll} />
            ) : null}
            {panel === 'helper' ? (
              <HelperChat systemId={systemId} canEdit={data.canEdit} onApplied={reloadAll} />
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

function ScheduleControl({ schedule, canEdit, onSet }: { schedule: Schedule; canEdit: boolean; onSet: (s: Schedule) => void }) {
  // Local optimistic mirrors of the server-owned schedule so the dropdown reflects
  // the choice immediately (no snap-back during the round-trip) and the cron field
  // re-syncs when the persisted value changes.
  const [kind, setKind] = useState<Schedule['kind']>(schedule.kind);
  const [cron, setCron] = useState(schedule.cron ?? '0 9 * * 1');
  useEffect(() => { setKind(schedule.kind); }, [schedule.kind]);
  useEffect(() => { if (schedule.cron) setCron(schedule.cron); }, [schedule.cron]);
  return (
    <div className="row" style={{ gap: 6, alignItems: 'center' }}>
      <select
        value={kind}
        disabled={!canEdit}
        onChange={(e) => {
          const next = e.target.value as Schedule['kind'];
          setKind(next);
          onSet(next === 'cron' ? { kind: next, cron } : next === 'event' ? { kind: next, event: 'on_demand' } : { kind: next });
        }}
        title="Schedule"
      >
        <option value="manual">manual</option>
        <option value="cron">cron</option>
        <option value="event">event</option>
      </select>
      {kind === 'cron' ? (
        <form onSubmit={(e) => { e.preventDefault(); onSet({ kind: 'cron', cron }); }}>
          <input type="text" value={cron} onChange={(e) => setCron(e.target.value)} disabled={!canEdit} style={{ width: 120 }} className="mono" />
        </form>
      ) : null}
    </div>
  );
}
