/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';
import { commitSystem } from './commitSystem';
import type { Capability, System } from '@/lib/agents/system-schema';

/**
 * System-level grants + the activity→model routing table (Tasks 5 & 6). Grants are
 * inherited by sub-agents and narrowable per agent (in the agent editor).
 * Connection grants carry a capability profile (Off / Read / Write-approval /
 * Write-bounded / Blocked) and can be probed: granted Read → allow, non-granted →
 * deny, Write-approval → requires_approval (held in the Governance queue). The
 * routing table is the workspace default; a per-activity override writes the
 * system's LiteLLM routing config (overrides), applied on Build.
 */

const CAPS: Capability[] = ['Off', 'Read', 'Write-approval', 'Write-bounded', 'Blocked'];

type RoutingData = {
  activities: string[];
  tiers: Record<string, string>;
  table: Record<string, { tier: string; model: string }>;
};

type ProbeResult = { effect: string; reason: string; held: boolean };

export default function GrantsRouting({
  systemId,
  system,
  canEdit,
  models,
  routing,
  onChanged,
}: {
  systemId: string;
  system: System;
  canEdit: boolean;
  models: string[];
  routing: RoutingData | null;
  onChanged: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [newConn, setNewConn] = useState('');
  const [newConnCap, setNewConnCap] = useState<Capability>('Read');
  const [probeId, setProbeId] = useState('');
  const [probes, setProbes] = useState<Record<string, ProbeResult>>({});

  const commit = async (mutate: (s: System) => void) => {
    if (busy) return;
    setBusy(true);
    setErr('');
    try {
      const next = structuredClone(system);
      mutate(next);
      await commitSystem(systemId, next);
      // Await the reload so the next grant edit builds from the fresh source.
      await onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const probe = async (connectionId: string, write: boolean) => {
    setErr('');
    try {
      const res = await fetch(`/api/agents/systems/${systemId}/probe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ connectionId, write }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Probe failed');
      setProbes((p) => ({ ...p, [`${connectionId}:${write ? 'w' : 'r'}`]: body }));
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const chipList = (label: string, items: string[], onAdd: (v: string) => void, onRemove: (v: string) => void, placeholder: string) => {
    return (
      <div className="grant-block">
        <div className="comp-label">{label}</div>
        <div className="chip-row">
          {items.length === 0 ? <span className="muted" style={{ fontSize: 12.5 }}>none</span> : null}
          {items.map((t) => (
            <span key={t} className="chip mono">
              {t}
              {canEdit ? (
                <button className="chip-x" disabled={busy} onClick={() => onRemove(t)} aria-label={`Remove ${t}`}>×</button>
              ) : null}
            </span>
          ))}
        </div>
        {canEdit ? <AddInline placeholder={placeholder} disabled={busy} onAdd={onAdd} /> : null}
      </div>
    );
  };

  return (
    <div className="grants-panel">
      {err ? <div className="error" style={{ marginBottom: 12 }}>{err}</div> : null}

      <div className="section-title" style={{ marginTop: 4 }}>Tool grants</div>
      <p className="hint" style={{ marginTop: 0 }}>Granted at the system level, inherited by sub-agents, narrowable per agent.</p>
      {chipList(
        'MCP tools',
        system.grants.tools,
        (v) => commit((s) => { if (!s.grants.tools.includes(v)) s.grants.tools.push(v); }),
        (v) => commit((s) => { s.grants.tools = s.grants.tools.filter((t) => t !== v); }),
        'add a tool, e.g. retrieve',
      )}
      <div className="row" style={{ gap: 18, flexWrap: 'wrap' }}>
        {chipList(
          'Data products',
          system.grants.data,
          (v) => commit((s) => { if (!s.grants.data.includes(v)) s.grants.data.push(v); }),
          (v) => commit((s) => { s.grants.data = s.grants.data.filter((t) => t !== v); }),
          'add a data product',
        )}
        {chipList(
          'Knowledge',
          system.grants.knowledge,
          (v) => commit((s) => { if (!s.grants.knowledge.includes(v)) s.grants.knowledge.push(v); }),
          (v) => commit((s) => { s.grants.knowledge = s.grants.knowledge.filter((t) => t !== v); }),
          'add a knowledge base',
        )}
      </div>

      <div className="section-title">Connections &amp; capability profiles</div>
      <p className="hint" style={{ marginTop: 0 }}>
        Each connection carries a capability profile. Probe to verify: granted Read → allow,
        non-granted → deny, Write-approval → held for approval in Governance.
      </p>
      <div className="table-wrap" style={{ marginBottom: 12 }}>
        <table>
          <thead>
            <tr><th>Connection</th><th>Capability</th><th>Probe</th><th>Result</th>{canEdit ? <th /> : null}</tr>
          </thead>
          <tbody>
            {system.grants.connections.length === 0 ? (
              <tr><td colSpan={canEdit ? 5 : 4} className="muted">No connections granted.</td></tr>
            ) : null}
            {system.grants.connections.map((c) => {
              const r = probes[`${c.id}:r`];
              const w = probes[`${c.id}:w`];
              return (
                <tr key={c.id}>
                  <td className="mono">{c.id}</td>
                  <td>
                    {canEdit ? (
                      <select
                        value={c.capability}
                        disabled={busy}
                        onChange={(e) => commit((s) => {
                          const conn = s.grants.connections.find((x) => x.id === c.id);
                          if (conn) conn.capability = e.target.value as Capability;
                        })}
                        style={{ minWidth: 150 }}
                      >
                        {CAPS.map((cap) => <option key={cap} value={cap}>{cap}</option>)}
                      </select>
                    ) : (
                      <span className="badge">{c.capability}</span>
                    )}
                  </td>
                  <td>
                    <div className="row" style={{ gap: 6 }}>
                      <button className="btn ghost sm" onClick={() => probe(c.id, false)}>Read</button>
                      <button className="btn ghost sm" onClick={() => probe(c.id, true)}>Write</button>
                    </div>
                  </td>
                  <td style={{ fontSize: 12 }}>
                    {r ? <div><ProbeBadge r={r} /> read</div> : null}
                    {w ? <div><ProbeBadge r={w} /> write</div> : null}
                    {!r && !w ? <span className="muted">—</span> : null}
                  </td>
                  {canEdit ? (
                    <td>
                      <button className="chip-x" disabled={busy} onClick={() => commit((s) => { s.grants.connections = s.grants.connections.filter((x) => x.id !== c.id); })} aria-label={`Remove ${c.id}`}>×</button>
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {canEdit ? (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
          <input type="text" value={newConn} onChange={(e) => setNewConn(e.target.value)} placeholder="connection id, e.g. crm" style={{ width: 200 }} />
          <select value={newConnCap} onChange={(e) => setNewConnCap(e.target.value as Capability)}>
            {CAPS.map((cap) => <option key={cap} value={cap}>{cap}</option>)}
          </select>
          <button
            className="btn sm"
            disabled={busy || !newConn.trim()}
            onClick={() => commit((s) => {
              const idv = newConn.trim();
              if (!s.grants.connections.some((x) => x.id === idv)) s.grants.connections.push({ id: idv, capability: newConnCap });
            }).then(() => setNewConn(''))}
          >
            Grant connection
          </button>
        </div>
      ) : null}

      <div className="grant-block" style={{ marginBottom: 12 }}>
        <div className="comp-label">Probe a non-granted connection (expect deny)</div>
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          <input type="text" value={probeId} onChange={(e) => setProbeId(e.target.value)} placeholder="e.g. crm_write" style={{ width: 200 }} />
          <button className="btn ghost sm" disabled={!probeId.trim()} onClick={() => probe(probeId.trim(), false)}>Probe</button>
          {probes[`${probeId.trim()}:r`] ? <span style={{ fontSize: 12 }}><ProbeBadge r={probes[`${probeId.trim()}:r`]} /> {probes[`${probeId.trim()}:r`].reason}</span> : null}
        </div>
      </div>

      <div className="section-title">Model routing — by activity</div>
      <p className="hint" style={{ marginTop: 0 }}>
        Workspace default (cheap-first): light → Ministral, reasoning → in-box Magistral (sovereign,
        STACKIT Qwen as fast fallback), vision → STACKIT Qwen. A per-activity override writes this
        system’s LiteLLM routing config (applied on Build). No endpoint in the UI — models come live
        from LiteLLM.
      </p>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Activity</th><th>Tier</th><th>Default model</th><th>System override</th></tr></thead>
          <tbody>
            {routing ? routing.activities.map((a) => {
              const row = routing.table[a];
              const override = system.routing.overrides[a];
              return (
                <tr key={a}>
                  <td>{a}</td>
                  <td><span className={`badge ${row.tier === 'light' ? 'ok' : 'warn'}`}>{row.tier}</span></td>
                  <td className="mono" style={{ fontSize: 12 }}>{row.model}</td>
                  <td>
                    {canEdit ? (
                      <select
                        value={override ?? ''}
                        disabled={busy}
                        onChange={(e) => commit((s) => {
                          if (e.target.value) s.routing.overrides[a] = e.target.value;
                          else delete s.routing.overrides[a];
                        })}
                        style={{ minWidth: 220 }}
                      >
                        <option value="">— default —</option>
                        {models.map((m) => <option key={m} value={m}>{m}</option>)}
                      </select>
                    ) : (
                      <span className="mono" style={{ fontSize: 12 }}>{override ?? '—'}</span>
                    )}
                  </td>
                </tr>
              );
            }) : <tr><td colSpan={4} className="muted">Loading routing…</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ProbeBadge({ r }: { r: ProbeResult }) {
  const cls = r.effect === 'allow' ? 'ok' : r.effect === 'requires_approval' ? 'warn' : 'err';
  const label = r.effect === 'allow' ? 'allow' : r.effect === 'requires_approval' ? (r.held ? 'approval ↗' : 'approval') : 'deny';
  return <span className={`badge ${cls}`}>{label}</span>;
}

function AddInline({ placeholder, disabled, onAdd }: { placeholder: string; disabled: boolean; onAdd: (v: string) => void }) {
  const [v, setV] = useState('');
  return (
    <form
      className="row"
      style={{ gap: 6, marginTop: 6, alignItems: 'center' }}
      onSubmit={(e) => { e.preventDefault(); if (v.trim()) { onAdd(v.trim()); setV(''); } }}
    >
      <input type="text" value={v} onChange={(e) => setV(e.target.value)} placeholder={placeholder} style={{ width: 200 }} />
      <button className="btn ghost sm" type="submit" disabled={disabled || !v.trim()}>Add</button>
    </form>
  );
}
