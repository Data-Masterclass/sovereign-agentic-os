/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import PageHeader from '@core/ui/PageHeader';
import { useApi } from '@core/ui/useApi';
import DetailView, { type DetailTarget } from '@tabs/monitoring/ui/DetailView';
import SpendSection from '@tabs/monitoring/ui/SpendSection';
import PanelsView, { type PanelKind } from '@tabs/monitoring/ui/PanelsView';
import GatewayPanel from '@tabs/admin/ui/GatewayPanel';
import { useUser } from '@core/ui/useUser';
import { roleAtLeast } from '@core/kernel/session';
import { getUrlParam, patchUrl } from '@core/kernel/url-params';
import { useTabNavReset } from '@core/kernel/tab-nav';
import './monitoring.css';
import { ago, compact, count, money } from '@tabs/monitoring/ui/format';
import { useTranslations, useFormat } from '@core/i18n/client';

/**
 * Monitoring — the artifact-centric read plane, with real telemetry on every
 * tile and a full diagnosis view on open. Two sections, each My · Domain · Company:
 *   • Agent Monitoring — each agent system with its last-7-day Cost · Tokens · Runs ·
 *     Last run · ⚠warnings/✗errors (Langfuse + the in-process governed ring).
 *   • Data Monitoring  — each dataset with freshness, DQ rules passing/violated, and
 *     pipeline + quality health (the real persisted DQ run).
 *   • Agents · Data · Platform panels (`?view=`, tabs/monitoring/ui/PanelsView.tsx) — runs over
 *     time, latency, tokens, key spend, OPA denials, Dagster job/test health, downstream impact,
 *     component probes, VictoriaMetrics pressure, VictoriaLogs error rates; Platform is admin-only.
 *   • Cost & Spend     — tenant spend vs the billing envelope (ADMIN ONLY; the tab
 *     itself is builder-visible, so the section is gated with roleAtLeast(role,
 *     'admin')). It moved here from Platform because the envelope is display-only:
 *     the whole surface is observation, which is Monitoring's job.
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
]; // the English labels stay for non-UI readers; the UI renders `page.scopes.<key>`

const DOT: Record<Health, string> = { green: 'h-green', amber: 'h-amber', red: 'h-red', grey: 'h-unknown' };
const DOT7: Record<Health7, string> = { ok: 'h-green', warn: 'h-amber', error: 'h-red' };
/** The health words — rendered through `page.health.<key>`. */
const WORD: Record<Health, 'green' | 'amber' | 'red' | 'grey'> = { green: 'green', amber: 'amber', red: 'red', grey: 'grey' };

function Dot({ cls, title }: { cls: string; title?: string }) {
  return <span className={`mon-dot ${cls}`} title={title} />;
}


function ScopeTabs({ scope, setScope, counts }: { scope: ScopeKey; setScope: (s: ScopeKey) => void; counts: Record<ScopeKey, number> }) {
  const t = useTranslations('monitoring');
  const { locale } = useFormat();
  return (
    <div className="seg" style={{ marginBottom: 12 }}>
      {SCOPES.map((s) => (
        <button key={s.key} className={scope === s.key ? 'on' : ''} onClick={() => setScope(s.key)} type="button">
          {t(`page.scopes.${s.key}`)} <span className="muted" style={{ fontSize: 11 }}>· {count(counts[s.key], locale)}</span>
        </button>
      ))}
    </div>
  );
}

function AgentTileCard({ a, onOpen }: { a: AgentTile; onOpen: () => void }) {
  const tr = useTranslations('monitoring');
  const { locale } = useFormat();
  const t = a.telemetry;
  const noTelemetry = t.runs === 0;
  const dotCls = noTelemetry ? DOT[a.health] : DOT7[t.overall];
  return (
    <div className="mon-tile" role="button" tabIndex={0} onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter') onOpen(); }} title={tr('page.openDiagnostics')}>
      <div className="mon-tile-head">
        <Dot cls={dotCls} title={noTelemetry ? tr(`page.health.${WORD[a.health]}`) : tr(`status.${t.overall}`)} />
        <span className="mon-tile-name">{a.name}</span>
        {a.running && <span className="badge ok">{tr('page.running')}</span>}
        {a.scheduled && <span className="badge">{tr('page.scheduled')}</span>}
      </div>
      {noTelemetry ? (
        <div className="mon-tile-facts muted">{tr('page.noTelemetry', { count: a.agentCount })}</div>
      ) : (
        <div className="mon-tile-facts">
          <span className="mon-fact">{tr.rich('page.cost', { value: money(t.costUsd, locale), b: (c) => <b>{c}</b> })}</span>
          <span className="mon-fact">{tr.rich('page.tokens', { value: compact(t.tokens, locale), b: (c) => <b>{c}</b> })}</span>
          <span className="mon-fact">{tr.rich('page.runs', { count: t.runs, b: (c) => <b>{c}</b> })}</span>
          <span className="mon-fact">{ago(a.lastRunAt7d, locale)}</span>
          {t.warnings > 0 && <span className="mon-fact warn">⚠ {count(t.warnings, locale)}</span>}
          {t.errors > 0 && <span className="mon-fact err">✗ {count(t.errors, locale)}</span>}
        </div>
      )}
    </div>
  );
}

function DataTileCard({ d, onOpen }: { d: DataRow; onOpen: () => void }) {
  const t = useTranslations('monitoring');
  const { locale } = useFormat();
  return (
    <div className="mon-tile" role="button" tabIndex={0} onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter') onOpen(); }} title={t('page.openDiagnostics')}>
      <div className="mon-tile-head">
        <Dot cls={DOT[d.health]} title={t(`page.health.${WORD[d.health]}`)} />
        <span className="mon-tile-name">{d.name}</span>
        {d.gold && <span className="badge">{t('page.gold')}</span>}
      </div>
      <div className="mon-tile-facts">
        <span className="mon-fact">{d.freshness ? t('page.built', { ago: ago(d.freshness, locale) }) : t('page.notBuilt')}</span>
        {d.dqHasRun ? (
          d.dqViolations > 0
            ? <span className="mon-fact err">{t('page.dqViolated', { count: d.dqViolations })}</span>
            : <span className="mon-fact ok">{t('page.dqPassing', { count: d.dqRules })}</span>
        ) : (
          <span className="mon-fact muted">{d.dqRules > 0 ? t('page.dqNotRun', { count: d.dqRules }) : t('page.noDqRules')}</span>
        )}
        <span className="mon-fact"><Dot cls={DOT[d.pipeline]} title={t('page.pipelineTitle', { health: t(`page.health.${WORD[d.pipeline]}`) })} /> {t('page.pipeline')}</span>
      </div>
    </div>
  );
}

export default function MonitoringPage() {
  const t = useTranslations('monitoring');
  const { data, loading, error, reload } = useApi<Feed>('/api/monitoring/artifacts');
  const { user } = useUser();
  // Tenant-wide spend is admin-only: Monitoring's minRole is 'builder', so the
  // section is hidden (not rendered) for anyone below admin. Fail-closed on null.
  const canSeeSpend = user ? roleAtLeast(user.role, 'admin') : false;
  const [agentScope, setAgentScope] = useState<ScopeKey>('mine');
  const [dataScope, setDataScope] = useState<ScopeKey>('mine');
  const [target, setTarget] = useState<DetailTarget | null>(null);
  // Agents · Data · Platform (admin) — persisted as ?view= so a reload or a shared link keeps it.
  const [picked, setView] = useState<PanelKind>('agents');
  // Platform is admin-only (the API answers 403 below admin); anyone else stays on Agents.
  const view: PanelKind = picked === 'platform' && !canSeeSpend ? 'agents' : picked;
  useEffect(() => {
    const v = getUrlParam('view');
    if (v === 'agents' || v === 'data' || v === 'platform' || v === 'files' || v === 'knowledge' || v === 'kpis' || v === 'dashboards' || v === 'software' || v === 'workflows') setView(v);
  }, []);
  const pickView = useCallback((v: PanelKind) => {
    setView(v);
    patchUrl({ view: v === 'agents' ? null : v });
  }, []);

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

  const open = useCallback((tg: DetailTarget) => {
    setTarget(tg);
    patchUrl(
      { agent: tg.kind === 'agent' ? tg.id : null, dataset: tg.kind === 'dataset' ? tg.id : null },
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
        <PageHeader title={t('page.title')} />
        <div className="content">
          <DetailView target={target} onBack={back} />
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader title={t('page.title')} />
      <div className="content">
        <div className="row" style={{ justifyContent: 'flex-end', alignItems: 'center' }}>
          <button className="btn ghost" onClick={reload} disabled={loading}>
            {loading ? <span className="spin" /> : t('page.refresh')}
          </button>
        </div>

        {error ? <div className="error" style={{ marginTop: 20 }}>{error}</div> : null}
        {!data && loading ? <div className="stub-page" style={{ marginTop: 20 }}>{t('page.loading')}</div> : null}

        <div className="seg mon-view-seg" role="tablist" aria-label={t('page.viewAria')}>
          <button type="button" role="tab" aria-selected={view === 'agents'} className={view === 'agents' ? 'on' : ''} onClick={() => pickView('agents')}>{t('page.views.agents')}</button>
          <button type="button" role="tab" aria-selected={view === 'data'} className={view === 'data' ? 'on' : ''} onClick={() => pickView('data')}>{t('page.views.data')}</button>
          <button type="button" role="tab" aria-selected={view === 'files'} className={view === 'files' ? 'on' : ''} onClick={() => pickView('files')}>{t('page.views.files')}</button>
          <button type="button" role="tab" aria-selected={view === 'knowledge'} className={view === 'knowledge' ? 'on' : ''} onClick={() => pickView('knowledge')}>{t('page.views.knowledge')}</button>
          <button type="button" role="tab" aria-selected={view === 'kpis'} className={view === 'kpis' ? 'on' : ''} onClick={() => pickView('kpis')}>{t('page.views.kpis')}</button>
          <button type="button" role="tab" aria-selected={view === 'dashboards'} className={view === 'dashboards' ? 'on' : ''} onClick={() => pickView('dashboards')}>{t('page.views.dashboards')}</button>
          <button type="button" role="tab" aria-selected={view === 'software'} className={view === 'software' ? 'on' : ''} onClick={() => pickView('software')}>{t('page.views.software')}</button>
          <button type="button" role="tab" aria-selected={view === 'workflows'} className={view === 'workflows' ? 'on' : ''} onClick={() => pickView('workflows')}>{t('page.views.workflows')}</button>
          {canSeeSpend && <button type="button" role="tab" aria-selected={view === 'platform'} className={view === 'platform' ? 'on' : ''} onClick={() => pickView('platform')}>{t('page.views.platform')}</button>}
        </div>

        {data && view === 'agents' && (
          <>
            <div className="section-title" style={{ marginTop: 18 }}>{t('page.agentsTitle')}</div>
            {!data.telemetryLive && (
              <p className="hint" style={{ marginTop: 0, marginBottom: 8, opacity: 0.75 }}>
                {t('page.langfuseDown')}
              </p>
            )}
            <div>
              <ScopeTabs scope={agentScope} setScope={setAgentScope} counts={agentCounts} />
            </div>
            {agentRows.length === 0 ? (
              <p className="hint" style={{ marginTop: 0 }}>
                {t.rich('page.agentsEmpty', { link: (c) => <a href="/agents">{c}</a> })}
              </p>
            ) : (
              <div className="mon-tile-grid">
                {agentRows.map((a) => (
                  <AgentTileCard key={a.id} a={a} onOpen={() => open({ kind: 'agent', id: a.id, name: a.name })} />
                ))}
              </div>
            )}

            <PanelsView kind="agents" />
          </>
        )}
        {data && view === 'data' && (
          <>
            <div className="section-title" style={{ marginTop: 18 }}>{t('page.dataTitle')}</div>
            <p className="hint" style={{ marginTop: 0, marginBottom: 8 }}>
              {t('page.dataHint')}
            </p>
            <ScopeTabs scope={dataScope} setScope={setDataScope} counts={dataCounts} />
            {dataRows.length === 0 ? (
              <p className="hint" style={{ marginTop: 0 }}>
                {t.rich('page.dataEmpty', { link: (c) => <a href="/data">{c}</a> })}
              </p>
            ) : (
              <div className="mon-tile-grid">
                {dataRows.map((d) => (
                  <DataTileCard key={d.id} d={d} onOpen={() => open({ kind: 'dataset', id: d.id, name: d.name })} />
                ))}
              </div>
            )}

            <PanelsView kind="data" />
          </>
        )}
        {view === 'files' && <PanelsView kind="files" />}
        {view === 'knowledge' && <PanelsView kind="knowledge" />}
        {view === 'kpis' && <PanelsView kind="kpis" />}
        {view === 'dashboards' && <PanelsView kind="dashboards" />}
        {view === 'software' && <PanelsView kind="software" />}
        {view === 'workflows' && <PanelsView kind="workflows" />}
        {canSeeSpend && view === 'platform' && (
          <>
            <PanelsView kind="platform" />
            <SpendSection />
            <GatewayPanel variant="spend" />
          </>
        )}
        {data && (
          <>
            <p className="hint" style={{ marginTop: 20, opacity: 0.7 }}>
              {t('page.ragNote')}
            </p>
          </>
        )}
      </div>
    </>
  );
}
