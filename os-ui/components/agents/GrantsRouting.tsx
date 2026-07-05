/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';
import { commitSystem } from './commitSystem';
import type { Capability, System } from '@/lib/agents/system-schema';
import { modelInfo, type ModelInfo } from '@/lib/agents/routing';

/** Mirrors CatalogEntry from lib/agents/tool-catalog — client-safe (no server import). */
type CatalogEntry = {
  name: string;
  tab: string;
  minRole: string;
  description: string;
  requires_approval: boolean;
};

const TAB_LABELS: Record<string, string> = {
  data: 'Data',
  knowledge: 'Knowledge',
  files: 'Files',
  metrics: 'Metrics',
  dashboards: 'Dashboards',
  bigbets: 'Big Bets',
  connections: 'Connections',
  science: 'Science',
  software: 'Software',
  agents: 'Agents',
  meta: 'Meta',
};

const TAB_ORDER = [
  'data', 'knowledge', 'files', 'metrics', 'dashboards',
  'bigbets', 'connections', 'science', 'software', 'agents', 'meta',
];

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
  models: ModelInfo[];
  routing: RoutingData | null;
  onChanged: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [newConn, setNewConn] = useState('');
  const [newConnCap, setNewConnCap] = useState<Capability>('Read');
  const [probeId, setProbeId] = useState('');
  const [probes, setProbes] = useState<Record<string, ProbeResult>>({});

  // --- tool picker state ----
  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [search, setSearch] = useState('');
  const [catalogLoading, setCatalogLoading] = useState(false);

  const openPicker = async () => {
    setShowPicker(true);
    if (catalog !== null) return; // already loaded
    setCatalogLoading(true);
    try {
      const res = await fetch('/api/agents/tool-catalog');
      if (!res.ok) throw new Error('Failed to load tool catalog');
      const data = (await res.json()) as { tools: CatalogEntry[] };
      setCatalog(data.tools);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setCatalogLoading(false);
    }
  };

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
      {/* MCP tool grants — replaced with a role-scoped picker */}
      {(() => {
        const q = search.toLowerCase();
        const filtered = (catalog ?? []).filter(
          (t) => !q || t.name.includes(q) || t.description.toLowerCase().includes(q),
        );
        const grouped = TAB_ORDER
          .map((tab) => [tab, filtered.filter((t) => t.tab === tab)] as [string, CatalogEntry[]])
          .filter(([, tools]) => tools.length > 0);

        return (
          <div className="grant-block">
            <div className="comp-label">MCP tools</div>
            <div className="chip-row">
              {system.grants.tools.length === 0 ? (
                <span className="muted" style={{ fontSize: 12.5 }}>none</span>
              ) : null}
              {system.grants.tools.map((t) => (
                <span key={t} className="chip mono">
                  {t}
                  {canEdit ? (
                    <button
                      className="chip-x"
                      disabled={busy}
                      onClick={() => commit((s) => { s.grants.tools = s.grants.tools.filter((x) => x !== t); })}
                      aria-label={`Remove ${t}`}
                    >×</button>
                  ) : null}
                </span>
              ))}
            </div>
            {canEdit ? (
              <div style={{ marginTop: 8 }}>
                {!showPicker ? (
                  <button className="btn ghost sm" disabled={busy} onClick={openPicker}>
                    Choose tools…
                  </button>
                ) : (
                  <div style={{
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius)',
                    background: 'var(--bg-elevated)',
                    padding: '12px 14px',
                    marginTop: 4,
                  }}>
                    <div className="row" style={{ alignItems: 'center', gap: 8, marginBottom: 10 }}>
                      <input
                        type="text"
                        placeholder="Search tools…"
                        value={search}
                        autoFocus
                        onChange={(e) => setSearch(e.target.value)}
                        style={{ flex: 1 }}
                      />
                      <button
                        className="btn ghost sm"
                        onClick={() => { setShowPicker(false); setSearch(''); }}
                      >
                        Done
                      </button>
                    </div>
                    {catalogLoading ? (
                      <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>Loading…</p>
                    ) : catalog === null ? null : grouped.length === 0 ? (
                      <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>No tools match.</p>
                    ) : grouped.map(([tab, tools]) => (
                      <div key={tab} style={{ marginBottom: 10 }}>
                        <div className="comp-label" style={{ marginBottom: 4 }}>
                          {TAB_LABELS[tab] ?? tab}
                        </div>
                        {tools.map((t) => {
                          const checked = system.grants.tools.includes(t.name);
                          return (
                            <label
                              key={t.name}
                              style={{
                                display: 'flex',
                                alignItems: 'flex-start',
                                gap: 8,
                                padding: '5px 0',
                                cursor: busy ? 'not-allowed' : 'pointer',
                              }}
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                disabled={busy}
                                style={{ marginTop: 2, flexShrink: 0 }}
                                onChange={() => {
                                  if (checked) {
                                    commit((s) => {
                                      s.grants.tools = s.grants.tools.filter((x) => x !== t.name);
                                    });
                                  } else {
                                    commit((s) => {
                                      if (!s.grants.tools.includes(t.name)) s.grants.tools.push(t.name);
                                    });
                                  }
                                }}
                              />
                              <span style={{ flex: 1, minWidth: 0 }}>
                                <span className="mono" style={{ fontSize: 12.5, fontWeight: 500 }}>
                                  {t.name}
                                </span>
                                {t.requires_approval ? (
                                  <span
                                    className="badge warn"
                                    style={{ fontSize: 10.5, marginLeft: 6, verticalAlign: 'middle' }}
                                  >
                                    needs approval
                                  </span>
                                ) : null}
                                <span
                                  className="muted"
                                  style={{ display: 'block', fontSize: 11.5, marginTop: 1, lineHeight: 1.4 }}
                                >
                                  {t.description.length > 120
                                    ? `${t.description.slice(0, 120)}…`
                                    : t.description}
                                </span>
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : null}
          </div>
        );
      })()}
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

      <div className="section-title">Workspace default routing</div>
      <p className="hint" style={{ marginTop: 0 }}>
        The <strong>Auto</strong> fallback every agent uses when it isn’t pinned to a specific model.
        Cheap-first: light work → Ministral, reasoning → in-box Magistral, vision → Qwen. An individual
        agent can override this from its own <strong>How this agent thinks</strong> toggle
        (Auto / Reasoning / Execution). A per-activity override here writes the system’s LiteLLM routing
        config, applied on Build.
      </p>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Activity</th><th>Tier</th><th>Default model</th><th>System override</th></tr></thead>
          <tbody>
            {routing ? routing.activities.map((a) => {
              const row = routing.table[a];
              const override = system.routing.overrides[a];
              const rowInfo = modelInfo(row.model);
              return (
                <tr key={a}>
                  <td>{a}</td>
                  <td><span className={`badge ${row.tier === 'light' ? 'ok' : 'warn'}`}>{row.tier}</span></td>
                  <td style={{ fontSize: 12 }}>
                    <span className="model-name">{rowInfo.display}</span>{' '}
                    <span className={`badge ${rowInfo.provenance === 'internal' ? 'ok' : 'warn'}`}>
                      {rowInfo.provenance === 'internal' ? 'in-box' : 'hosted'}
                    </span>
                  </td>
                  <td>
                    {canEdit ? (
                      <select
                        value={override ?? ''}
                        disabled={busy}
                        onChange={(e) => commit((s) => {
                          if (e.target.value) s.routing.overrides[a] = e.target.value;
                          else delete s.routing.overrides[a];
                        })}
                        style={{ minWidth: 240 }}
                      >
                        <option value="">— default —</option>
                        {models.map((m) => (
                          <option key={m.model_name} value={m.model_name}>
                            {m.display} — {m.provenance === 'internal' ? 'in-box' : 'hosted'}
                          </option>
                        ))}
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
