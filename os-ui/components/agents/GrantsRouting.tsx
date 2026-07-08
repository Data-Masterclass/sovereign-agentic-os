/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { commitSystem } from './commitSystem';
import type { ArtifactGrant, Capability, System } from '@/lib/agents/system-schema';
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

/**
 * The uniform per-artifact access model (data / knowledge / metrics / connections).
 * `Off` means "not granted" (no entry in the grants list). `Write (direct)` maps to
 * the `Write-bounded` capability and is BUILDER-ONLY — hidden here AND rejected
 * server-side at the save boundary (system-schema.assertGrantsWithinRole).
 */
type Access = 'Off' | 'Read' | 'Write-approval' | 'Write-bounded';
const ACCESS_OPTIONS: { value: Access; label: string; direct?: boolean }[] = [
  { value: 'Off', label: 'Off' },
  { value: 'Read', label: 'Read' },
  { value: 'Write-approval', label: 'Write (needs approval)' },
  { value: 'Write-bounded', label: 'Write (direct)', direct: true },
];

type Available = { id: string; name: string; scope: 'personal' | 'domain' | 'marketplace' };
type GrantField = 'data' | 'knowledge' | 'metrics' | 'connections';
type Kind = 'data' | 'knowledge' | 'metric' | 'connection';

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
  canDirectWrite,
  models,
  routing,
  onChanged,
}: {
  systemId: string;
  system: System;
  canEdit: boolean;
  /** True when the current user ranks builder+ (may select Write (direct)). */
  canDirectWrite: boolean;
  models: ModelInfo[];
  routing: RoutingData | null;
  onChanged: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
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
      <div className="section-title">Data, Knowledge &amp; Metrics grants</div>
      <p className="hint" style={{ marginTop: 0 }}>
        Browse what you can access — your personal artifacts, your domain’s, and anything added from the
        Marketplace — and choose per-artifact access. <strong>Read</strong> marks it queryable;
        <strong> Write (needs approval)</strong> marks writes as held-for-approval;
        <strong> Write (direct)</strong> is direct write, builder-only.
      </p>
      <p className="hint" style={{ marginTop: 0, fontSize: 11.5 }}>
        The builder-gate on <strong>Write (direct)</strong> is enforced at save and re-checked against the
        owner’s current role at run time (a demoted owner’s direct writes fall back to held-for-approval).
        These data/knowledge/metric capabilities are also enforced in the offline Build-verification
        gateway. On the <strong>live cluster</strong>, data/knowledge/metric access takes effect through the
        system’s tool grants, OPA policy, run-as-user rights and dataset-level security —{' '}
        <strong>per-artifact live enforcement is a labelled follow-up</strong>. <strong>Connections</strong>{' '}
        below are enforced live per call today.
      </p>
      <ArtifactGrantList
        systemId={systemId} kind="data" field="data" label="Data products"
        emptyText="No data products you can access." grants={system.grants.data}
        canEdit={canEdit} canDirectWrite={canDirectWrite} busy={busy} commit={commit}
      />
      <ArtifactGrantList
        systemId={systemId} kind="knowledge" field="knowledge" label="Knowledge"
        emptyText="No knowledge workflows you can access." grants={system.grants.knowledge}
        canEdit={canEdit} canDirectWrite={canDirectWrite} busy={busy} commit={commit}
      />
      <ArtifactGrantList
        systemId={systemId} kind="metric" field="metrics" label="Metrics"
        emptyText="No metrics you can access." grants={system.grants.metrics}
        canEdit={canEdit} canDirectWrite={canDirectWrite} busy={busy} commit={commit}
      />

      <div className="section-title">Connections &amp; capability profiles</div>
      <p className="hint" style={{ marginTop: 0 }}>
        Browse the connections you can access and grant per-connection capability. Probe to verify:
        granted Read → allow, non-granted → deny, Write (needs approval) → held for approval in Governance.
      </p>
      <ArtifactGrantList
        systemId={systemId} kind="connection" field="connections" label="Connections"
        emptyText="No connections you can access." grants={system.grants.connections}
        canEdit={canEdit} canDirectWrite={canDirectWrite} busy={busy} commit={commit}
        renderProbe={(id) => {
          const r = probes[`${id}:r`];
          const w = probes[`${id}:w`];
          return (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
              <button className="btn ghost sm" onClick={() => probe(id, false)}>Read</button>
              <button className="btn ghost sm" onClick={() => probe(id, true)}>Write</button>
              <span>
                {r ? <span style={{ marginRight: 6 }}><ProbeBadge r={r} /> r</span> : null}
                {w ? <span><ProbeBadge r={w} /> w</span> : null}
              </span>
            </div>
          );
        }}
      />

      <div className="grant-block" style={{ marginBottom: 12, marginTop: 12 }}>
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
        Cheap-first: light work → Standard, reasoning → Reasoning, vision → the vision model. An individual
        agent can override this from its own <strong>How this agent thinks</strong> toggle
        (Auto / Standard / Reasoning). A per-activity override here writes the system’s LiteLLM routing
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

const SCOPE_BADGE: Record<Available['scope'], string> = { personal: 'personal', domain: 'domain', marketplace: 'marketplace' };

/**
 * One browsable, searchable grant list for an artifact type (data / knowledge /
 * metrics / connections). Loads what the caller can see from the scoped
 * `…/grants/available?kind=` endpoint, merges any already-granted ids that are no
 * longer listed so nothing is hidden, and gives each row a scope badge + an access
 * `<select>`. The `Write (direct)` option is hidden unless the user is a builder —
 * server-side enforcement still rejects it on save regardless of the UI.
 */
function ArtifactGrantList({
  systemId, kind, field, label, emptyText, grants, canEdit, canDirectWrite, busy, commit, renderProbe,
}: {
  systemId: string;
  kind: Kind;
  field: GrantField;
  label: string;
  emptyText: string;
  grants: ArtifactGrant[];
  canEdit: boolean;
  canDirectWrite: boolean;
  busy: boolean;
  commit: (mutate: (s: System) => void) => Promise<void>;
  renderProbe?: (id: string) => ReactNode;
}) {
  const [available, setAvailable] = useState<Available[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadErr, setLoadErr] = useState('');
  const [search, setSearch] = useState('');

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setLoadErr('');
    fetch(`/api/agents/systems/${systemId}/grants/available?kind=${kind}`, { cache: 'no-store' })
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? 'Failed to load');
        if (alive) setAvailable(body.items as Available[]);
      })
      .catch((e) => { if (alive) setLoadErr((e as Error).message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [systemId, kind]);

  const capOf = (id: string): Access => {
    const g = grants.find((x) => x.id === id);
    return (g ? g.capability : 'Off') as Access;
  };

  const setAccess = (id: string, access: Access) => {
    commit((s) => {
      const arr = s.grants[field];
      const rest = arr.filter((x) => x.id !== id);
      s.grants[field] = access === 'Off' ? rest : [...rest, { id, capability: access }];
    });
  };

  // Merge granted-but-unlisted ids (e.g. an artifact you can no longer browse) so
  // an existing grant is always visible + removable — never silently orphaned.
  const rows: Available[] = (() => {
    const listed = available ?? [];
    const knownIds = new Set(listed.map((a) => a.id));
    const extra: Available[] = grants
      .filter((g) => !knownIds.has(g.id))
      .map((g) => ({ id: g.id, name: g.id, scope: 'personal' as const }));
    const all = [...listed, ...extra];
    const q = search.trim().toLowerCase();
    return q ? all.filter((a) => a.name.toLowerCase().includes(q) || a.id.toLowerCase().includes(q)) : all;
  })();

  const options = ACCESS_OPTIONS.filter((o) => canDirectWrite || !o.direct);

  return (
    <div className="grant-block" style={{ marginBottom: 14 }}>
      <div className="row" style={{ alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
        <div className="comp-label" style={{ margin: 0 }}>{label}</div>
        {available && available.length > 6 ? (
          <input
            type="text"
            placeholder={`Search ${label.toLowerCase()}…`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: 200 }}
          />
        ) : null}
      </div>
      {loadErr ? <div className="error" style={{ marginBottom: 8 }}>{loadErr}</div> : null}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th><th style={{ width: 96 }}>Scope</th><th style={{ width: 190 }}>Access</th>
              {renderProbe ? <th style={{ width: 220 }}>Probe</th> : null}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={renderProbe ? 4 : 3} className="muted">Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={renderProbe ? 4 : 3} className="muted">{search ? 'No matches.' : emptyText}</td></tr>
            ) : rows.map((a) => {
              const cur = capOf(a.id);
              return (
                <tr key={a.id}>
                  <td style={{ maxWidth: 0 }}>
                    <span
                      title={`${a.name} (${a.id})`}
                      style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    >
                      {a.name}
                    </span>
                  </td>
                  <td><span className="badge muted">{SCOPE_BADGE[a.scope]}</span></td>
                  <td>
                    {canEdit ? (
                      <select
                        value={cur}
                        disabled={busy}
                        onChange={(e) => setAccess(a.id, e.target.value as Access)}
                        style={{ minWidth: 180 }}
                      >
                        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    ) : (
                      <span className={`badge ${cur === 'Off' ? 'muted' : ''}`}>
                        {ACCESS_OPTIONS.find((o) => o.value === cur)?.label ?? cur}
                      </span>
                    )}
                  </td>
                  {renderProbe ? <td>{renderProbe(a.id)}</td> : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {canEdit && !canDirectWrite ? (
        <p className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>
          Direct write (no approval) is builder-only — grant “Write (needs approval)” to route writes through Governance.
        </p>
      ) : null}
    </div>
  );
}
