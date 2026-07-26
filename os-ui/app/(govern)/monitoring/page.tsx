/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import PageHeader from '@/components/PageHeader';
import { useApi } from '@/lib/useApi';
import DetailView, { type DetailTarget } from '@/components/monitoring/DetailView';
import { getUrlParam, patchUrl } from '@/lib/core/url-params';
import { useTabNavReset } from '@/lib/core/tab-nav';
import { anchorAttr, ANCHORS } from '@/lib/tutorials/anchors';
import './monitoring.css';

/**
 * Monitoring — the artifact-centric read plane, with real telemetry on every
 * tile and a full diagnosis view on open. Two sections, each My · Domain · Company:
 *   • Agent Monitoring — each agent system with its last-7-day Cost · Tokens · Runs ·
 *     Last run · ⚠warnings/✗errors (Langfuse + the in-process governed ring).
 *   • Data Monitoring  — each dataset with freshness, DQ rules passing/violated, and
 *     pipeline + quality health (the real persisted DQ run).
 * Read-only, scoped to the caller's own governed lists.
 *
 * Tab-consistent detail (same pattern as Data's tiles→DataBuilder and Agents'
 * list→SystemView): clicking a tile swaps the grids for the diagnosis view IN THE
 * MAIN WINDOW, "← Monitoring" returns. The open artifact is persisted in the URL
 * (`?agent=<id>` / `?dataset=<id>`) so a reload restores the view and browser
 * Back closes it.
 */

type Health = 'green' | 'amber' | 'red' | 'grey';
type Health7 = 'ok' | 'warn' | 'error';
type ScopeKey = 'mine' | 'domain' | 'marketplace';

type Telemetry = { costUsd: number; tokens: number; runs: number; lastRunAt: number | null; warnings: number; errors: number; overall: Health7 };
type AgentTile = {
  id: string; name: string; scope: ScopeKey; agentCount: number;
  running: boolean; scheduled: boolean; held: number; health: Health;
  telemetry: Telemetry; lastRunAt7d: number | null;
};
type DataRow = {
  id: string; name: string; scope: ScopeKey; health: Health;
  pipeline: Health; dq: Health; quality: 'unknown' | 'passing' | 'failing';
  freshness: string | null; ageDays: number | null; gold: boolean;
  dqRules: number; dqViolations: number; dqHasRun: boolean;
};
type Feed = {
  agents: { mine: AgentTile[]; domain: AgentTile[]; marketplace: AgentTile[] };
  data: { mine: DataRow[]; domain: DataRow[]; marketplace: DataRow[] };
  telemetryLive: boolean;
};

const SCOPES: { key: ScopeKey; label: string }[] = [
  { key: 'mine', label: 'My' },
  { key: 'domain', label: 'Domain' },
  { key: 'marketplace', label: 'Company' },
];

const DOT: Record<Health, string> = { green: 'h-green', amber: 'h-amber', red: 'h-red', grey: 'h-unknown' };
const DOT7: Record<Health7, string> = { ok: 'h-green', warn: 'h-amber', error: 'h-red' };
const WORD: Record<Health, string> = { green: 'Healthy', amber: 'Attention', red: 'Failing', grey: 'No signal' };

function Dot({ cls, title }: { cls: string; title?: string }) {
  return <span className={`mon-dot ${cls}`} title={title} />;
}

function ago(at: number | string | null): string {
  if (at == null) return '—';
  const t = typeof at === 'number' ? at : Date.parse(at);
  if (Number.isNaN(t)) return '—';
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24); if (d < 30) return `${d}d ago`;
  return `${Math.floor(d / 30)}mo ago`;
}
// Zero/absent cost renders '—' (matching the other absent facts, e.g. `ago`):
// runs whose models carry no explicit price are UNPRICED, not free — never "$0".
const money = (n: number) => (n >= 1 ? `€${n.toFixed(2)}` : n > 0 ? `€${n.toFixed(3)}` : '—');
const compact = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);

function ScopeTabs({ scope, setScope, counts }: { scope: ScopeKey; setScope: (s: ScopeKey) => void; counts: Record<ScopeKey, number> }) {
  return (
    <div className="seg" style={{ marginBottom: 12 }}>
      {SCOPES.map((s) => (
        <button key={s.key} className={scope === s.key ? 'on' : ''} onClick={() => setScope(s.key)} type="button">
          {s.label} <span className="muted" style={{ fontSize: 11 }}>· {counts[s.key]}</span>
        </button>
      ))}
    </div>
  );
}

function AgentTileCard({ a, onOpen }: { a: AgentTile; onOpen: () => void }) {
  const t = a.telemetry;
  const noTelemetry = t.runs === 0;
  const dotCls = noTelemetry ? DOT[a.health] : DOT7[t.overall];
  return (
    <div className="mon-tile" role="button" tabIndex={0} onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter') onOpen(); }} title="Open diagnostics">
      <div className="mon-tile-head">
        <Dot cls={dotCls} title={noTelemetry ? WORD[a.health] : t.overall} />
        <span className="mon-tile-name">{a.name}</span>
        {a.running && <span className="badge ok">running</span>}
        {a.scheduled && <span className="badge">scheduled</span>}
      </div>
      {noTelemetry ? (
        <div className="mon-tile-facts muted">No telemetry yet · {a.agentCount} agent{a.agentCount === 1 ? '' : 's'}</div>
      ) : (
        <div className="mon-tile-facts">
          <span className="mon-fact"><b>{money(t.costUsd)}</b> cost</span>
          <span className="mon-fact"><b>{compact(t.tokens)}</b> tok</span>
          <span className="mon-fact"><b>{t.runs}</b> run{t.runs === 1 ? '' : 's'}</span>
          <span className="mon-fact">{ago(a.lastRunAt7d)}</span>
          {t.warnings > 0 && <span className="mon-fact warn">⚠ {t.warnings}</span>}
          {t.errors > 0 && <span className="mon-fact err">✗ {t.errors}</span>}
        </div>
      )}
    </div>
  );
}

function DataTileCard({ d, onOpen }: { d: DataRow; onOpen: () => void }) {
  return (
    <div className="mon-tile" role="button" tabIndex={0} onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter') onOpen(); }} title="Open diagnostics">
      <div className="mon-tile-head">
        <Dot cls={DOT[d.health]} title={WORD[d.health]} />
        <span className="mon-tile-name">{d.name}</span>
        {d.gold && <span className="badge">gold</span>}
      </div>
      <div className="mon-tile-facts">
        <span className="mon-fact">{d.freshness ? `built ${ago(d.freshness)}` : 'not built'}</span>
        {d.dqHasRun ? (
          d.dqViolations > 0
            ? <span className="mon-fact err">✗ {d.dqViolations} DQ rule{d.dqViolations === 1 ? '' : 's'} violated</span>
            : <span className="mon-fact ok">✓ {d.dqRules} DQ rule{d.dqRules === 1 ? '' : 's'} passing</span>
        ) : (
          <span className="mon-fact muted">{d.dqRules > 0 ? `${d.dqRules} DQ rule${d.dqRules === 1 ? '' : 's'} · not run` : 'no DQ rules'}</span>
        )}
        <span className="mon-fact"><Dot cls={DOT[d.pipeline]} title={`Pipeline: ${WORD[d.pipeline]}`} /> pipeline</span>
      </div>
    </div>
  );
}

export default function MonitoringPage() {
  const { data, loading, error, reload } = useApi<Feed>('/api/monitoring/artifacts');
  const [agentScope, setAgentScope] = useState<ScopeKey>('mine');
  const [dataScope, setDataScope] = useState<ScopeKey>('mine');
  const [target, setTarget] = useState<DetailTarget | null>(null);

  // Deep-link + back/forward: the open artifact lives in the URL (?agent= / ?dataset=),
  // mirroring the Agents tab's ?system= convention.
  useEffect(() => {
    const sync = () => {
      const agent = getUrlParam('agent');
      const dataset = getUrlParam('dataset');
      setTarget(agent ? { kind: 'agent', id: agent } : dataset ? { kind: 'dataset', id: dataset } : null);
    };
    sync();
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);

  const open = useCallback((t: DetailTarget) => {
    setTarget(t);
    patchUrl(
      { agent: t.kind === 'agent' ? t.id : null, dataset: t.kind === 'dataset' ? t.id : null },
      { push: true }, // browser Back closes the detail view
    );
  }, []);
  const back = useCallback(() => {
    setTarget(null);
    patchUrl({ agent: null, dataset: null });
  }, []);
  // Clicking the Monitoring sidebar link while a detail view is open returns to
  // the tiles (same-route client nav doesn't re-mount this page).
  useTabNavReset(back);

  const agentCounts = useMemo(() => ({
    mine: data?.agents.mine.length ?? 0, domain: data?.agents.domain.length ?? 0, marketplace: data?.agents.marketplace.length ?? 0,
  }), [data]);
  const dataCounts = useMemo(() => ({
    mine: data?.data.mine.length ?? 0, domain: data?.data.domain.length ?? 0, marketplace: data?.data.marketplace.length ?? 0,
  }), [data]);

  const agentRows = data?.agents[agentScope] ?? [];
  const dataRows = data?.data[dataScope] ?? [];

  // Detail open → the diagnosis view replaces the tile grids in the main window.
  if (target) {
    return (
      <>
        <PageHeader title="Monitoring" crumb="agents · data — the read plane" tutorial="monitoring" />
        <div className="content">
          <DetailView target={target} onBack={back} />
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Monitoring" crumb="agents · data — the read plane" tutorial="monitoring" />
      <div className="content" {...anchorAttr(ANCHORS.monitoring.sandbox)}>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <p className="lead" style={{ marginBottom: 0 }}>
            Real 7-day health of the agent systems and datasets you can access. Open any
            tile for full diagnostics — run history &amp; traces, cost/token trends, data-quality
            checks, build timeline and lineage.
          </p>
          <button className="btn ghost" onClick={reload} disabled={loading}>
            {loading ? <span className="spin" /> : 'Refresh'}
          </button>
        </div>

        {error ? <div className="error" style={{ marginTop: 20 }}>{error}</div> : null}
        {!data && loading ? <div className="stub-page" style={{ marginTop: 20 }}>Loading…</div> : null}

        {data && (
          <>
            <div className="section-title" style={{ marginTop: 18 }} {...anchorAttr(ANCHORS.monitoring.agents)}>Agent Monitoring</div>
            {!data.telemetryLive && (
              <p className="hint" style={{ marginTop: 0, marginBottom: 8, opacity: 0.75 }}>
                Langfuse unreachable — showing in-process run telemetry only (durable history returns when it&apos;s back).
              </p>
            )}
            <div {...anchorAttr(ANCHORS.monitoring.scope)}>
              <ScopeTabs scope={agentScope} setScope={setAgentScope} counts={agentCounts} />
            </div>
            {agentRows.length === 0 ? (
              <p className="hint" style={{ marginTop: 0 }}>
                No agent systems here yet — build or run one in the <a href="/agents">Agents</a> tab.
              </p>
            ) : (
              <div className="mon-tile-grid">
                {agentRows.map((a) => (
                  <AgentTileCard key={a.id} a={a} onOpen={() => open({ kind: 'agent', id: a.id, name: a.name })} />
                ))}
              </div>
            )}

            <div className="section-title" style={{ marginTop: 26 }} {...anchorAttr(ANCHORS.monitoring.data)}>Data Monitoring</div>
            <p className="hint" style={{ marginTop: 0, marginBottom: 8 }}>
              Freshness, pipeline health and data-quality per dataset — the real last DQ run.
            </p>
            <ScopeTabs scope={dataScope} setScope={setDataScope} counts={dataCounts} />
            {dataRows.length === 0 ? (
              <p className="hint" style={{ marginTop: 0 }}>
                No datasets here yet — create one in the <a href="/data">Data</a> tab.
              </p>
            ) : (
              <div className="mon-tile-grid">
                {dataRows.map((d) => (
                  <DataTileCard key={d.id} d={d} onOpen={() => open({ kind: 'dataset', id: d.id, name: d.name })} />
                ))}
              </div>
            )}

            <p className="hint" style={{ marginTop: 20, opacity: 0.7 }}>
              RAG monitoring (Knowledge &amp; Files) is coming next. Spend lives in the LLM Gateway tab;
              policy and caps live in Governance.
            </p>
          </>
        )}
      </div>
    </>
  );
}
