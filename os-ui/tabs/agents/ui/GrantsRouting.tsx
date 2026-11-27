/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { commitSystem } from '@tabs/agents/ui/commitSystem';
import type { ArtifactGrant, Capability, System } from '@tabs/agents/lib/system-schema';
import type { GrantWarning } from '@tabs/agents/lib/grant-access';
import { GrantWarningNote, GrantCheckNotice, type GrantCheckState } from '@tabs/agents/ui/GrantPickers';
import { modelInfo } from '@tabs/agents/lib/routing';
import { useTranslations } from '@core/i18n/client';

/** Mirrors CatalogEntry from lib/agents/tool-catalog — client-safe (no server import). */
type CatalogEntry = {
  name: string;
  tab: string;
  minRole: string;
  description: string;
  requires_approval: boolean;
};

/** The tool-catalog group headings (`routing.tab.<tab>`); an unknown tab shows its id. */
const TAB_LABELS: Record<string, 'data' | 'knowledge' | 'files' | 'metrics' | 'dashboards' | 'connections' | 'software' | 'agents' | 'meta'> = {
  data: 'data',
  knowledge: 'knowledge',
  files: 'files',
  metrics: 'metrics',
  dashboards: 'dashboards',
  connections: 'connections',
  software: 'software',
  agents: 'agents',
  meta: 'meta',
};

const TAB_ORDER = [
  'data', 'knowledge', 'files', 'metrics', 'dashboards',
  'connections', 'software', 'agents', 'meta',

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
const ACCESS_OPTIONS: { value: Access; labelKey: 'off' | 'read' | 'writeApproval' | 'writeDirect'; direct?: boolean }[] = [
  { value: 'Off', labelKey: 'off' },
  { value: 'Read', labelKey: 'read' },
  { value: 'Write-approval', labelKey: 'writeApproval' },
  { value: 'Write-bounded', labelKey: 'writeDirect', direct: true },
];

type Available = { id: string; name: string; scope: 'personal' | 'domain' | 'marketplace' };
type GrantField = 'data' | 'knowledge' | 'workflows' | 'metrics' | 'connections';
type Kind = 'data' | 'knowledge' | 'workflows' | 'metric' | 'connection';

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
  roles,
  routing,
  onChanged,
}: {
  systemId: string;
  system: System;
  canEdit: boolean;
  /** True when the current user ranks builder+ (may select Write (direct)). */
  canDirectWrite: boolean;
  /** The LIVE platform-admin role models the Standard/Reasoning options pin to —
   *  the only two choices agent routing offers (same as the per-agent picker). */
  roles: { reasoning: string; standard: string };
  routing: RoutingData | null;
  onChanged: () => void | Promise<void>;
}) {
  const t = useTranslations('agents');
  // The tool picker's loop names each catalog entry `t` (the canonical-name test reads it); it uses `tr`.
  const tr = t;
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
      if (!res.ok) throw new Error(t('routing.loadCatalogFailed'));
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
      if (!res.ok) throw new Error(body.error ?? t('routing.probeFailed'));
      setProbes((p) => ({ ...p, [`${connectionId}:${write ? 'w' : 'r'}`]: body }));
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="grants-panel">
      {err ? <div className="error" style={{ marginBottom: 12 }}>{err}</div> : null}

      <div className="section-title" style={{ marginTop: 4 }}>{t('routing.toolGrants')}</div>
      <p className="hint" style={{ marginTop: 0 }}>{t('routing.toolHint')}</p>
      {/* MCP tool grants — replaced with a role-scoped picker */}
      {(() => {
        const q = search.toLowerCase();
        const filtered = (catalog ?? []).filter(
          (e) => !q || e.name.includes(q) || e.description.toLowerCase().includes(q),
        );
        const grouped = TAB_ORDER
          .map((tab) => [tab, filtered.filter((e) => e.tab === tab)] as [string, CatalogEntry[]])
          .filter(([, tools]) => tools.length > 0);

        return (
          <div className="grant-block">
            <div className="comp-label">{t('routing.mcpTools')}</div>
            <div className="chip-row">
              {system.grants.tools.length === 0 ? (
                <span className="muted" style={{ fontSize: 12.5 }}>{t('routing.none')}</span>
              ) : null}
              {system.grants.tools.map((tool) => (
                <span key={tool} className="chip mono">
                  {tool}
                  {canEdit ? (
                    <button
                      className="chip-x"
                      disabled={busy}
                      onClick={() => commit((s) => { s.grants.tools = s.grants.tools.filter((x) => x !== tool); })}
                      aria-label={t('routing.removeTool', { tool })}
                    >×</button>
                  ) : null}
                </span>
              ))}
            </div>
            {canEdit ? (
              <div style={{ marginTop: 8 }}>
                {!showPicker ? (
                  <button className="btn ghost sm" disabled={busy} onClick={openPicker}>
                    {t('routing.chooseTools')}
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
                        placeholder={t('routing.searchTools')}
                        value={search}
                        autoFocus
                        onChange={(e) => setSearch(e.target.value)}
                        style={{ flex: 1 }}
                      />
                      <button
                        className="btn ghost sm"
                        onClick={() => { setShowPicker(false); setSearch(''); }}
                      >
                        {t('routing.done')}
                      </button>
                    </div>
                    {catalogLoading ? (
                      <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>{t('routing.loading')}</p>
                    ) : catalog === null ? null : grouped.length === 0 ? (
                      <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>{t('routing.noTools')}</p>
                    ) : grouped.map(([tab, tools]) => (
                      <div key={tab} style={{ marginBottom: 10 }}>
                        <div className="comp-label" style={{ marginBottom: 4 }}>
                          {TAB_LABELS[tab] ? t(`routing.tab.${TAB_LABELS[tab]}`) : tab}
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
                                    {tr('routing.needsApproval')}
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
      <div className="section-title">{t('routing.artifactTitle')}</div>
      <p className="hint" style={{ marginTop: 0 }}>
        {t.rich('routing.artifactHint', { b: (c) => <strong>{c}</strong> })}
      </p>
      <p className="hint" style={{ marginTop: 0, fontSize: 11.5 }}>
        {t.rich('routing.enforcementHint', { b: (c) => <strong>{c}</strong> })}
      </p>
      <ArtifactGrantList
        systemId={systemId} kind="data" field="data" label={t('routing.list.data.label')}
        searchPlaceholder={t('routing.list.data.search')}
        emptyText={t('routing.list.data.empty')} grants={system.grants.data}
        canEdit={canEdit} canDirectWrite={canDirectWrite} busy={busy} commit={commit}
      />
      <ArtifactGrantList
        systemId={systemId} kind="knowledge" field="knowledge" label={t('routing.list.knowledge.label')}
        searchPlaceholder={t('routing.list.knowledge.search')}
        emptyText={t('routing.list.knowledge.empty')} grants={system.grants.knowledge}
        canEdit={canEdit} canDirectWrite={canDirectWrite} busy={busy} commit={commit}
      />
      <ArtifactGrantList
        systemId={systemId} kind="workflows" field="workflows" label={t('routing.list.workflows.label')}
        searchPlaceholder={t('routing.list.workflows.search')}
        emptyText={t('routing.list.workflows.empty')} grants={system.grants.workflows ?? []}
        canEdit={canEdit} canDirectWrite={canDirectWrite} busy={busy} commit={commit}
      />
      <ArtifactGrantList
        systemId={systemId} kind="metric" field="metrics" label={t('routing.list.metric.label')}
        searchPlaceholder={t('routing.list.metric.search')}
        emptyText={t('routing.list.metric.empty')} grants={system.grants.metrics}
        canEdit={canEdit} canDirectWrite={canDirectWrite} busy={busy} commit={commit}
      />

      <div className="section-title">{t('routing.connTitle')}</div>
      <p className="hint" style={{ marginTop: 0 }}>
        {t('routing.connHint')}
      </p>
      <ArtifactGrantList
        systemId={systemId} kind="connection" field="connections" label={t('routing.list.connection.label')}
        searchPlaceholder={t('routing.list.connection.search')}
        emptyText={t('routing.list.connection.empty')} grants={system.grants.connections}
        canEdit={canEdit} canDirectWrite={canDirectWrite} busy={busy} commit={commit}
        renderProbe={(id) => {
          const r = probes[`${id}:r`];
          const w = probes[`${id}:w`];
          return (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
              <button className="btn ghost sm" onClick={() => probe(id, false)}>{t('routing.probeRead')}</button>
              <button className="btn ghost sm" onClick={() => probe(id, true)}>{t('routing.probeWrite')}</button>
              <span>
                {r ? <span style={{ marginRight: 6 }}><ProbeBadge r={r} /> {t('routing.probeReadShort')}</span> : null}
                {w ? <span><ProbeBadge r={w} /> {t('routing.probeWriteShort')}</span> : null}
              </span>
            </div>
          );
        }}
      />

      <div className="grant-block" style={{ marginBottom: 12, marginTop: 12 }}>
        <div className="comp-label">{t('routing.probeTitle')}</div>
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          <input type="text" value={probeId} onChange={(e) => setProbeId(e.target.value)} placeholder={t('routing.probePlaceholder')} style={{ width: 200 }} />
          <button className="btn ghost sm" disabled={!probeId.trim()} onClick={() => probe(probeId.trim(), false)}>{t('routing.probe')}</button>
          {probes[`${probeId.trim()}:r`] ? <span style={{ fontSize: 12 }}><ProbeBadge r={probes[`${probeId.trim()}:r`]} /> {probes[`${probeId.trim()}:r`].reason}</span> : null}
        </div>
      </div>

      <div className="section-title">{t('routing.routingTitle')}</div>
      <p className="hint" style={{ marginTop: 0 }}>
        {t.rich('routing.routingHint', { b: (c) => <strong>{c}</strong> })}
      </p>
      <p className="hint" role="note" style={{ marginTop: 0 }}>{t('routing.runtimeNote')}</p>
      <div className="table-wrap">
        <table>
          <thead><tr><th>{t('routing.thActivity')}</th><th>{t('routing.thTier')}</th><th>{t('routing.thDefaultModel')}</th><th>{t('routing.thOverride')}</th></tr></thead>
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
                      {rowInfo.provenance === 'internal' ? t('routing.inBox') : t('routing.hosted')}
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
                        {/* Agent routing offers only the two governed tiers —
                            Standard + Reasoning — pinned to the LIVE admin role
                            models (never the raw LiteLLM catalog). */}
                        <option value="">{t('routing.defaultOption')}</option>
                        <option value={roles.standard}>{t('routing.standard')}</option>
                        <option value={roles.reasoning}>{t('routing.reasoning')}</option>
                      </select>
                    ) : (
                      <span className="mono" style={{ fontSize: 12 }}>{override ?? '—'}</span>
                    )}
                  </td>
                </tr>
              );
            }) : <tr><td colSpan={4} className="muted">{t('routing.loadingRouting')}</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ProbeBadge({ r }: { r: ProbeResult }) {
  const t = useTranslations('agents');
  const cls = r.effect === 'allow' ? 'ok' : r.effect === 'requires_approval' ? 'warn' : 'err';
  const label = r.effect === 'allow' ? t('routing.effect.allow') : r.effect === 'requires_approval' ? (r.held ? t('routing.effect.approvalHeld') : t('routing.effect.approval')) : t('routing.effect.deny');
  return <span className={`badge ${cls}`}>{label}</span>;
}

const SCOPE_BADGE = { personal: 'routing.scope.personal', domain: 'routing.scope.domain', marketplace: 'routing.scope.marketplace' } as const satisfies Record<Available['scope'], string>;

/**
 * One browsable, searchable grant list for an artifact type (data / knowledge /
 * metrics / connections). Loads what the caller can see from the scoped
 * `…/grants/available?kind=` endpoint, merges any already-granted ids that are no
 * longer listed so nothing is hidden, and gives each row a scope badge + an access
 * `<select>`. The `Write (direct)` option is hidden unless the user is a builder —
 * server-side enforcement still rejects it on save regardless of the UI.
 */
function ArtifactGrantList({
  systemId, kind, field, label, searchPlaceholder, emptyText, grants, canEdit, canDirectWrite, busy, commit, renderProbe,
}: {
  systemId: string;
  kind: Kind;
  field: GrantField;
  label: string;
  searchPlaceholder: string;
  emptyText: string;
  grants: ArtifactGrant[];
  canEdit: boolean;
  canDirectWrite: boolean;
  busy: boolean;
  commit: (mutate: (s: System) => void) => Promise<void>;
  renderProbe?: (id: string) => ReactNode;
}) {
  const t = useTranslations('agents');
  const [available, setAvailable] = useState<Available[] | null>(null);
  const [warnings, setWarnings] = useState<GrantWarning[]>([]);
  const [grantCheck, setGrantCheck] = useState<GrantCheckState | undefined>(undefined);
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
        if (!res.ok) throw new Error(body.error ?? t('routing.loadFailed'));
        if (alive) {
          setAvailable(body.items as Available[]);
          setWarnings((body.grantWarnings ?? []) as GrantWarning[]);
          setGrantCheck(body.grantCheck as GrantCheckState | undefined);
        }
      })
      .catch((e) => { if (alive) setLoadErr((e as Error).message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [systemId, kind, t]);

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
  // The name falls back to a friendly "(unavailable) <short-id>" label (the warning below it says why) — never the raw
  // machine id — so the user knows it's an orphaned grant and can remove it.
  const rows: Available[] = (() => {
    const listed = available ?? [];
    const knownIds = new Set(listed.map((a) => a.id));
    const extra: Available[] = grants
      .filter((g) => !knownIds.has(g.id))
      .map((g) => {
        const short = g.id.includes('_') ? g.id.split('_').slice(1).join('_') : g.id;
        return { id: g.id, name: t('routing.unavailable', { id: short }), scope: 'personal' as const };
      });
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
            placeholder={searchPlaceholder}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: 200 }}
          />
        ) : null}
      </div>
      {loadErr ? <div className="error" style={{ marginBottom: 8 }}>{loadErr}</div> : null}
      <GrantCheckNotice check={grantCheck} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t('routing.thName')}</th><th style={{ width: 96 }}>{t('routing.thScope')}</th><th style={{ width: 190 }}>{t('routing.thAccess')}</th>
              {renderProbe ? <th style={{ width: 220 }}>{t('routing.thProbe')}</th> : null}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={renderProbe ? 4 : 3} className="muted">{t('routing.loading')}</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={renderProbe ? 4 : 3} className="muted">{search ? t('routing.noMatches') : emptyText}</td></tr>
            ) : rows.map((a) => {
              const cur = capOf(a.id);
              // A granted id the caller cannot use: say why (server-resolved, never naming it).
              const warning = warnings.find((w) => w.id === a.id);
              return (
                <tr key={a.id}>
                  <td style={{ maxWidth: 0 }}>
                    <span
                      title={`${a.name} (${a.id})`}
                      style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    >
                      {a.name}
                    </span>
                    {warning ? <GrantWarningNote warning={warning} /> : null}
                  </td>
                  <td><span className="badge muted">{t(SCOPE_BADGE[a.scope])}</span></td>
                  <td>
                    {canEdit ? (
                      <select
                        value={cur}
                        disabled={busy}
                        onChange={(e) => setAccess(a.id, e.target.value as Access)}
                        style={{ minWidth: 180 }}
                      >
                        {options.map((o) => <option key={o.value} value={o.value}>{t(`routing.access.${o.labelKey}`)}</option>)}
                      </select>
                    ) : (
                      <span className={`badge ${cur === 'Off' ? 'muted' : ''}`}>
                        {(() => { const o = ACCESS_OPTIONS.find((x) => x.value === cur); return o ? t(`routing.access.${o.labelKey}`) : cur; })()}
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
          {t('routing.directWriteNote')}
        </p>
      ) : null}
    </div>
  );
}
