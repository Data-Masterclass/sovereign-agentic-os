/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The Monitoring panels — Agents · Data · Platform — rendered from /api/monitoring/panels
 * USER STORY: As an operator, an agentic engineer or a data engineer I want the panels for my systems
 *             and datasets on one page, with a link into Langfuse or Dagster wherever a number comes
 *             from, and a plain note wherever a component did not answer or offers no such signal.
 * ARCHITECTURE:
 *   - Client component; one fetch per view (`?view=agents|data|platform`). Renders what the payload
 *     says: a source that is `unavailable` shows its reason and its numbers as "—", never 0.
 *   - Uses the tab's existing classes (mon-sub, mon-stats, mon-table, badge); the small run chart is
 *     inline SVG. No new UI library.
 *   - i18n: every label, header and status word renders through the `monitoring` catalog (status words via
 *     `status-labels.ts`); numbers, times and money through the locale-aware helpers in `format.ts`. Text the
 *     SERVER wrote is shown verbatim in English (source reasons, "not available upstream" notes, component
 *     details, failure reasons, the software status label) — except platform alerts the server coded (wave 4:
 *     `Alert.i18n`), which render `server.monitoring.alert.*` through `useServerMessage()`.
 */
'use client';

import { useMemo, useState } from 'react';
import { useApi } from '@core/ui/useApi';
import { useTranslations, useFormat, useServerMessage } from '@core/i18n/client';
import type { AgentsView, AgentSystemPanel } from '@tabs/monitoring/lib/panels/agents-panel';
import type { DataView, DatasetPanel, RulePanel } from '@tabs/monitoring/lib/panels/data-panel';
import type { PlatformView } from '@tabs/monitoring/lib/panels/platform-panel';
import type { FilesView, FilePanel, DrivePanel } from '@tabs/monitoring/lib/panels/files-panel';
import type { KnowledgeView } from '@tabs/monitoring/lib/panels/knowledge-panel';
import type { KpisView } from '@tabs/monitoring/lib/panels/kpis-panel';
import type { DashboardsView } from '@tabs/monitoring/lib/panels/dashboards-panel';
import type { SoftwareView, SoftwareApp } from '@tabs/monitoring/lib/panels/software-panel';
import type { WorkflowsView } from '@tabs/monitoring/lib/panels/workflows-panel';
import type { NotUpstream, SourceState } from '@tabs/monitoring/lib/panels/panels-core';
import { ago, compact, count, day, decimals, gib, ms, pct, stamp, usd } from '@tabs/monitoring/ui/format';
import { statusKey } from '@tabs/monitoring/ui/status-labels';

export type PanelKind = 'agents' | 'data' | 'platform' | 'files' | 'knowledge' | 'kpis' | 'dashboards' | 'software' | 'workflows';

/** The tab's translator, the active locale, and `st(raw)` — a known status word in the user's language, else verbatim. */
function useLabels() {
  const t = useTranslations('monitoring');
  const { locale, number } = useFormat();
  const st = (raw: string | null | undefined): string => {
    const k = statusKey(raw);
    return k ? t(`status.${k}`) : String(raw ?? '');
  };
  return { t, locale, number, st };
}

function Sources({ sources }: { sources: Record<string, SourceState> }) {
  const { t } = useLabels();
  const down = Object.entries(sources).filter(([, s]) => s.state !== 'live');
  if (down.length === 0) return null;
  return (
    <div className="mon-dq-row" style={{ marginBottom: 10 }}>
      {down.map(([k, s]) => (
        <span key={k} className="badge warn" title={'reason' in s ? s.reason : ''}>
          {t(s.state === 'unavailable' ? 'panels.sources.unavailable' : 'panels.sources.notOffered', { name: k, reason: 'reason' in s ? s.reason : '' })}
        </span>
      ))}
    </div>
  );
}

function NotOffered({ items }: { items: NotUpstream[] }) {
  const { t } = useLabels();
  if (!items.length) return null;
  return (
    <>
      <div className="mon-sub">{t('panels.notOffered')}</div>
      <ul className="hint" style={{ marginTop: 0, paddingLeft: 18 }}>
        {items.map((n) => (
          <li key={n.panel}><b>{n.panel}.</b> {n.reason}</li>
        ))}
      </ul>
    </>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'warn' | 'error' }) {
  return (
    <div className={`mon-stat${tone ? ` ${tone}` : ''}`}>
      <div className="mon-stat-v">{value}</div>
      <div className="mon-stat-l">{label}</div>
    </div>
  );
}

/** Runs per day, stacked: done · held · other · failed. */
function RunBars({ days, windowDays }: { days: NonNullable<AgentSystemPanel['runs']>['days']; windowDays: number }) {
  const { t, locale, st } = useLabels();
  const today = new Date();
  const cols = Array.from({ length: windowDays }, (_, i) => {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - (windowDays - 1 - i)));
    const key = d.toISOString().slice(0, 10);
    return days.find((x) => x.day === key) ?? { day: key, done: 0, failed: 0, held: 0, active: 0, other: 0 };
  });
  const max = Math.max(1, ...cols.map((c) => c.done + c.failed + c.held + c.active + c.other));
  const w = 100 / windowDays;
  const parts: [keyof (typeof cols)[number], string][] = [['done', 'var(--teal)'], ['active', 'var(--teal)'], ['held', 'var(--gold)'], ['other', 'var(--text-faint)'], ['failed', 'var(--danger)']];
  return (
    <div className="mon-spark" aria-label={t('panels.runs.aria')}>
      <svg viewBox="0 0 100 44" preserveAspectRatio="none" role="img">
        {cols.map((c, i) => {
          let y = 44;
          return parts.map(([k, color]) => {
            const n = c[k] as number;
            if (!n) return null;
            const h = (n / max) * 42;
            y -= h;
            return <rect key={`${c.day}-${k}`} x={i * w + w * 0.15} y={y} width={w * 0.7} height={h} fill={color}><title>{t('panels.runs.barTitle', { day: day(c.day, locale), count: count(n, locale), state: st(k) })}</title></rect>;
          });
        })}
      </svg>
      <div className="mon-spark-foot"><span>{cols[0] ? day(cols[0].day, locale) : undefined}</span><span>{t('panels.runs.foot')}</span><span>{cols.at(-1) ? day(cols.at(-1)!.day, locale) : undefined}</span></div>
    </div>
  );
}

function AgentCard({ s, v }: { s: AgentSystemPanel; v: AgentsView }) {
  const { t: tr, locale, st } = useLabels();
  const runs = s.runs;
  const totals = runs ? runs.days.reduce((a, d) => ({ done: a.done + d.done, failed: a.failed + d.failed, held: a.held + d.held }), { done: 0, failed: 0, held: 0 }) : null;
  const t = s.traces;
  const b = (c: React.ReactNode) => <b>{c}</b>;
  return (
    <div className="mon-stat" style={{ padding: '14px 16px' }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <b>{s.name}</b>
        <span>
          <a className="mon-xlink" href={s.agentsUrl}>{tr('panels.agent.agentsLink')}</a>{' '}
          {v.links.langfuse && <a className="mon-xlink" href={`${v.links.langfuse}`} target="_blank" rel="noreferrer">Langfuse ↗</a>}
        </span>
      </div>
      {s.keyDrift && (
        <p className={`hint ${s.keyDrift.action === 'corrected' ? '' : 'err'}`} role="alert" style={{ margin: '6px 0 0' }}>
          {tr.rich(s.keyDrift.action === 'corrected' ? 'panels.agent.keyDriftCorrected' : 'panels.agent.keyDriftDiffers', { since: ago(s.keyDrift.since, locale), changes: s.keyDrift.changes.join('; '), b })}{' '}
          {s.keyDrift.action === 'alert' && tr('panels.agent.keyDriftAlert')}
          {s.keyDrift.action === 'correction-failed' && tr('panels.agent.keyDriftFailed')}
        </p>
      )}
      {runs ? <RunBars days={runs.days} windowDays={v.runWindowDays} /> : <p className="hint">{tr('panels.agent.runsNone')}</p>}
      <div className="mon-stats" style={{ marginTop: 10 }}>
        <Stat label={tr('panels.agent.runsOk', { days: v.runWindowDays })} value={totals ? count(totals.done, locale) : '—'} />
        <Stat label={tr('panels.agent.failed')} value={totals ? count(totals.failed, locale) : '—'} tone={totals?.failed ? 'error' : undefined} />
        <Stat label={tr('panels.agent.held')} value={totals ? count(totals.held, locale) : '—'} tone={totals?.held ? 'warn' : undefined} />
        <Stat label={tr('panels.agent.latency', { days: v.windowDays })} value={t === undefined ? '—' : t ? `${ms(t.p50Ms, locale)} / ${ms(t.p95Ms, locale)}` : tr('panels.agent.noTraces')} />
        <Stat label={tr('panels.agent.tokens')} value={t === undefined ? '—' : t ? compact(t.tokens, locale) : '0'} />
        <Stat label={tr('panels.agent.keySpend')} value={s.keySpendUsd === undefined ? '—' : s.keySpendUsd === null ? tr('panels.agent.noKey') : usd(s.keySpendUsd, locale)} />
      </div>
      <div className="mon-dq-row" style={{ marginTop: 6 }}>
        {s.policy !== undefined && (
          <>
            <span className={`badge${s.policy?.denies ? ' err' : ' muted'}`} title={tr('panels.agent.opaLog')}>{tr('panels.agent.opaDeny', { count: count(s.policy?.denies ?? 0, locale) })}</span>
            <span className={`badge${s.policy?.held ? ' warn' : ' muted'}`} title={tr('panels.agent.opaLog')}>{tr('panels.agent.approvalRequired', { count: count(s.policy?.held ?? 0, locale) })}</span>
          </>
        )}
        {runs && <span className={`badge${runs.failureClasses.budget_exceeded ? ' err' : ' muted'}`} title={tr('panels.agent.budgetTitle')}>{tr('panels.agent.budgetExceeded', { count: count(runs.failureClasses.budget_exceeded, locale) })}</span>}
        {runs && <span className={`badge${runs.failureClasses.other ? ' err' : ' muted'}`}>{tr('panels.agent.otherFailure', { count: count(runs.failureClasses.other, locale) })}</span>}
        {s.approvalsWaiting && <span className={`badge${s.approvalsWaiting.length ? ' warn' : ' muted'}`}>{tr('panels.agent.approvalsWaiting', { count: count(s.approvalsWaiting.length, locale) })}</span>}
      </div>
      {s.policy && s.policy.byTool.filter((x) => x.effect !== 'allow').length > 0 && (
        <p className="hint" style={{ margin: '2px 0 6px' }}>
          {tr('panels.agent.deniedTools', { list: s.policy.byTool.filter((x) => x.effect !== 'allow').slice(0, 4).map((x) => tr('panels.agent.toolItem', { tool: x.tool, effect: st(x.effect), count: count(x.n, locale) })).join(' · ') })}
        </p>
      )}
      {s.approvalsWaiting && s.approvalsWaiting.length > 0 && (
        <p className="hint" style={{ margin: '2px 0 6px' }}>
          {tr.rich('panels.agent.waiting', {
            list: s.approvalsWaiting.slice(0, 3).map((a) => tr('panels.agent.waitingItem', { title: a.title, ago: ago(a.createdAt, locale) })).join(' · '),
            link: (c) => <a href="/governance">{c}</a>,
          })}
        </p>
      )}
      {runs && runs.lastFailures.length > 0 && (
        <div className="mon-table" style={{ marginTop: 6 }}>
          {runs.lastFailures.map((f) => (
            <div key={f.runId} className="mon-tr mon-tr-pfail err">
              <span className="muted">{ago(f.at, locale)}</span>
              <span className="ellip" title={f.reason}>{f.node ? `${f.node}: ` : ''}{f.reason || st('failed')}</span>
              <span>
                {f.traceUrl && <a className="mon-xlink" href={f.traceUrl} target="_blank" rel="noreferrer">{tr('panels.agent.trace')}</a>}{' '}
                <a className="mon-xlink" href={f.runUrl}>{tr('panels.agent.runsLink')}</a>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AgentsPanels({ v }: { v: AgentsView }) {
  const { t } = useLabels();
  return (
    <div className="mon-panels">
      <div className="mon-sub">{t('panels.agents.title')} <span className="mon-sub-note">{t('panels.agents.note')}</span></div>
      <Sources sources={v.sources} />
      {v.systems.length === 0 ? (
        <p className="hint">{t('panels.agents.empty')}</p>
      ) : (
        <div className="mon-tile-grid">{v.systems.map((s) => <AgentCard key={s.id} s={s} v={v} />)}</div>
      )}
      <NotOffered items={v.notUpstream} />
    </div>
  );
}

function DatasetCard({ d, v }: { d: DatasetPanel; v: DataView }) {
  const { t, locale, st } = useLabels();
  const failingJobs = (d.jobs ?? []).filter((j) => j.lastStatus === 'FAILURE');
  const last = d.trend?.at(-1);
  const testItem = (f: { name: string; violations: number | null }) => (f.violations !== null ? t('panels.dataset.testRows', { name: f.name, count: f.violations }) : f.name);
  return (
    <div className="mon-stat" style={{ padding: '14px 16px' }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <b>{d.name}</b>
        <span>
          <a className="mon-xlink" href={d.dataUrl}>{t('panels.dataset.dataLink')}</a>{' '}
          {d.testedAssetUrl && <a className="mon-xlink" href={d.testedAssetUrl} target="_blank" rel="noreferrer">Dagster ↗</a>}
        </span>
      </div>
      <div className="mon-stats" style={{ marginTop: 10 }}>
        <Stat label={t('panels.dataset.lastSuccess')} value={d.lastSuccessAt === undefined ? '—' : d.lastSuccessAt ? ago(d.lastSuccessAt, locale) : t('panels.never')} tone={d.lastSuccessAt === null ? 'warn' : undefined} />
        <Stat label={t('panels.dataset.failingJobs')} value={d.jobs ? count(failingJobs.length, locale) : '—'} tone={failingJobs.length ? 'error' : undefined} />
        <Stat label={t('panels.dataset.testsFailing')} value={d.tests && !d.tests.unavailable ? `${count(d.tests.failing.length, locale)} / ${count(d.tests.total, locale)}` : '—'} tone={d.tests?.failing.length ? 'error' : undefined} />
        <Stat label={t('panels.dataset.quality')} value={last ? `${count(last.passed, locale)}/${count(last.total, locale)}` : '—'} />
      </div>
      {d.trend && d.trend.length > 1 && (
        <p className="hint" style={{ margin: '2px 0 6px' }}>{t('panels.dataset.trend', { trend: d.trend.map((p) => `${count(p.passed, locale)}/${count(p.total, locale)}`).join(' → ') })}</p>
      )}
      {d.tests?.unavailable && (
        <p className="hint" style={{ margin: '2px 0 6px' }}>
          {t('panels.dataset.testsUnavailable', { reason: d.tests.unavailable.reason })}{' '}
          {d.tests.unavailable.lastKnown
            ? t('panels.dataset.lastKnown', { badge: d.tests.unavailable.lastKnown.badge, at: stamp(d.tests.unavailable.lastKnown.ranAt, locale) })
            : t('panels.dataset.noEarlier')}
        </p>
      )}
      {d.tests && d.tests.failing.length > 0 && (
        <p className="hint" style={{ margin: '2px 0 6px' }}>
          {t('panels.dataset.failing', { list: d.tests.failing.map(testItem).join(' · ') })}
          {d.tests.source === 'os' ? ` ${t('panels.dataset.osProbe')}` : ''}
        </p>
      )}
      {(d.laneAlerts?.length ?? 0) > 0 && (
        <div className="mon-tr err" role="alert" style={{ marginTop: 6 }}>
          <span>{t('panels.dataset.laneAlert', { count: d.laneAlerts!.length, models: d.laneAlerts![0].models.join(', ') })}{d.laneAlerts![0].hidden ? ` ${t('panels.hidden', { count: count(d.laneAlerts![0].hidden, locale) })}` : ''}
            {d.laneAlerts![0].url ? <> <a className="mon-xlink" href={d.laneAlerts![0].url} target="_blank" rel="noreferrer">{t('panels.runLink')}</a></> : null}</span>
        </div>
      )}
      {d.tests && d.tests.warning?.length > 0 && (
        <p className="hint" style={{ margin: '2px 0 6px' }}>
          {t('panels.dataset.warnings', { list: d.tests.warning.map(testItem).join(' · ') })}
        </p>
      )}
      {(d.jobs?.length ?? 0) + (d.schedules?.length ?? 0) > 0 && (
        <div className="mon-table" style={{ marginTop: 6 }}>
          <div className="mon-tr mon-th mon-tr-pjob"><span>{t('panels.dataset.colJob')}</span><span>{t('panels.dataset.colLast')}</span><span>{t('panels.dataset.colLastSuccess')}</span><span>{t('panels.dataset.colFails')}</span></div>
          {[...(d.jobs ?? []).map((j) => ({ ...j, kind: 'job' })), ...(d.schedules ?? []).map((s) => ({ ...s, kind: 'schedule' }))].map((j) => (
            <div key={`${j.kind}-${j.name}`} className={`mon-tr mon-tr-pjob${j.lastStatus === 'FAILURE' ? ' err' : ''}`}>
              <span className="mono ellip" title={j.name}>{j.kind === 'schedule' ? '⏱ ' : ''}{j.name}</span>
              <span>
                {'lastFailureUrl' in j && j.lastFailureUrl && j.lastStatus === 'FAILURE'
                  ? <a className="mon-xlink" href={String(j.lastFailureUrl)} target="_blank" rel="noreferrer">{st(j.lastStatus.toLowerCase())} ↗</a>
                  : st(j.lastStatus.toLowerCase())}
              </span>
              <span className="muted">{j.lastSuccessAt ? ago(j.lastSuccessAt, locale) : t('panels.never')}</span>
              <span>{count(j.failures, locale)}/{count(j.runs, locale)}</span>
            </div>
          ))}
        </div>
      )}
      {d.downstream && d.downstream.length > 0 && (d.tests?.failing.length || failingJobs.length) ? (
        <p className="hint" style={{ margin: '6px 0 0' }}>
          {t('panels.dataset.impacted')} {d.downstream.slice(0, 6).map((k, i) => (
            <span key={k.key}>{i ? ' · ' : ''}{k.url ? <a href={k.url} target="_blank" rel="noreferrer">{k.key}</a> : k.key}</span>
          ))}{d.downstream.length > 6 ? ` +${count(d.downstream.length - 6, locale)}` : ''}
        </p>
      ) : d.downstream && d.downstream.length > 0 ? (
        <p className="hint" style={{ margin: '6px 0 0' }}>{t('panels.dataset.downstream', { count: d.downstream.length })}</p>
      ) : null}
      {d.downstreamHidden && (
        <p className="hint" style={{ margin: '4px 0 0' }}>
          {t(d.tests?.failing.length || failingJobs.length ? 'panels.dataset.alsoImpacted' : 'panels.dataset.alsoDownstream', { count: d.downstreamHidden.count })}
        </p>
      )}
      {v.sources.dagsterRuns.state === 'live' && (d.jobs?.length ?? 0) === 0 && <p className="hint" style={{ margin: '6px 0 0' }}>{t('panels.dataset.noRuns')}</p>}
    </div>
  );
}

type FlatRule = RulePanel & { datasetId: string; datasetName: string; domain: string; dataUrl: string };
const RULE_ORDER: Record<RulePanel['status'], number> = { fail: 0, warn: 1, unavailable: 2, not_run: 3, pass: 4 };

/** Data quality per rule and per dataset — failing rules first; filter by domain and dataset. */
function RuleQuality({ v }: { v: DataView }) {
  const { t, locale, st } = useLabels();
  const [domain, setDomain] = useState('');
  const [dataset, setDataset] = useState('');
  const all = useMemo<FlatRule[]>(
    () => v.datasets.flatMap((d) => (d.rules ?? []).map((r) => ({ ...r, datasetId: d.id, datasetName: d.name, domain: d.domain, dataUrl: d.dataUrl }))),
    [v.datasets],
  );
  const domains = [...new Set(all.map((r) => r.domain).filter(Boolean))].sort();
  const datasets = [...new Map(all.filter((r) => !domain || r.domain === domain).map((r) => [r.datasetId, r.datasetName])).entries()];
  const rows = all
    .filter((r) => (!domain || r.domain === domain) && (!dataset || r.datasetId === dataset))
    .sort((a, b) => RULE_ORDER[a.status] - RULE_ORDER[b.status] || a.datasetName.localeCompare(b.datasetName) || a.name.localeCompare(b.name));
  const failing = all.filter((r) => r.status === 'fail').length;
  const warning = all.filter((r) => r.status === 'warn').length;
  const unreadable = all.filter((r) => r.status === 'unavailable').length;
  const tone = (s: RulePanel['status']) => (s === 'fail' ? ' err' : s === 'warn' ? ' warn' : s === 'pass' ? ' ok' : s === 'unavailable' ? ' warn' : ' muted');
  return (
    <>
      <div className="mon-sub">{t('panels.rules.title')} <span className="mon-sub-note">{t('panels.rules.note')}</span></div>
      <div className="mon-stats">
        <Stat label={t('panels.rules.rules')} value={count(all.length, locale)} />
        <Stat label={t('panels.rules.failing')} value={count(failing, locale)} tone={failing ? 'error' : undefined} />
        <Stat label={t('panels.rules.warning')} value={count(warning, locale)} tone={warning ? 'warn' : undefined} />
        {unreadable > 0 && <Stat label={t('panels.rules.unavailable')} value={count(unreadable, locale)} tone="warn" />}
      </div>
      {v.rulesDatasetsOmitted > 0 && <p className="hint">{t('panels.rules.omitted', { count: v.rulesDatasetsOmitted })}</p>}
      {all.length === 0 ? (
        <p className="hint">{v.sources.tests.state === 'live' ? t('panels.rules.emptyLive') : t('panels.rules.emptyDown')}</p>
      ) : (
        <>
          <div className="mon-dq-row" style={{ marginBottom: 8 }}>
            <select aria-label={t('panels.rules.filterDomain')} value={domain} onChange={(e) => { setDomain(e.target.value); setDataset(''); }}>
              <option value="">{t('panels.rules.allDomains')}</option>
              {domains.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
            <select aria-label={t('panels.rules.filterDataset')} value={dataset} onChange={(e) => setDataset(e.target.value)}>
              <option value="">{t('panels.rules.allDatasets')}</option>
              {datasets.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
          </div>
          <div className="mon-table">
            <div className="mon-tr mon-th mon-tr-prule"><span>{t('panels.rules.colRule')}</span><span>{t('panels.rules.colStatus')}</span><span>{t('panels.rules.colFailingRows')}</span><span>{t('panels.rules.colLastRun')}</span><span>{t('panels.rules.colFailingSince')}</span><span>{t('panels.rules.colTrend')}</span></div>
            {rows.map((r) => (
              <div key={`${r.datasetId}-${r.name}`} className={`mon-tr mon-tr-prule${r.status === 'fail' ? ' err' : ''}`}>
                <span className="ellip" title={r.name}>
                  <span className="mono">{r.name}</span> <span className="badge muted">{r.type}</span>
                  <br /><a className="mon-xlink" href={r.dataUrl}>{r.datasetName}</a> <span className="muted">· {r.domain}</span>
                </span>
                <span>
                  <span className={`badge${tone(r.status)}`}>{st(r.status)}{r.severity ? ` · ${st(r.severity)}` : ''}</span>
                  {r.status === 'unavailable' && (
                    <span className="hint" style={{ display: 'block', margin: '2px 0 0' }}>
                      {r.unavailableReason}
                      {r.lastRecorded && ` · ${t('panels.rules.lastRecorded', { status: st(r.lastRecorded.status) })}${r.lastRecorded.failingRows !== undefined ? ` ${t('panels.rowsSuffix', { count: r.lastRecorded.failingRows })}` : ''}${r.lastRecorded.at ? `, ${stamp(r.lastRecorded.at, locale)}` : ''}`}
                    </span>
                  )}
                </span>
                <span>{r.status === 'fail' || r.status === 'warn' ? (r.failingRows !== undefined ? count(r.failingRows, locale) : '—') : ''}</span>
                <span className="muted">
                  {r.lastRunAt ? ago(r.lastRunAt, locale) : '—'}{' '}
                  {r.runUrl && <a className="mon-xlink" href={r.runUrl} target="_blank" rel="noreferrer">{t('panels.runLink')}</a>}
                </span>
                <span className="muted">{r.failingSince ? (r.failingSinceExact ? ago(r.failingSince, locale) : t('panels.rules.before', { ago: ago(r.failingSince, locale) })) : ''}</span>
                <span className="mono" title={t('panels.rules.trendTitle')}>{(r.trend ?? []).map((p) => (p.passed ? '✓' : '✗')).join(' ') || '—'}</span>
              </div>
            ))}
          </div>
          <p className="hint">{t('panels.rules.footnote')}</p>
        </>
      )}
    </>
  );
}

function DataPanels({ v }: { v: DataView }) {
  const { t, locale } = useLabels();
  const sorted = [...v.datasets].sort((a, b) => score(b) - score(a));
  return (
    <div className="mon-panels">
      <div className="mon-sub">{t('panels.data.title')} <span className="mon-sub-note">{t('panels.data.note')}</span></div>
      <Sources sources={v.sources} />
      {v.laneAlerts.map((a) => (
        <div key={a.runId} className="mon-tr err" role="alert">
          <span>{a.models.length ? t('panels.data.handLaunchedModels', { models: a.models.join(', ') }) : t('panels.data.handLaunched')}{a.hidden ? ` ${t('panels.hidden', { count: count(a.hidden, locale) })}` : ''}
            {a.url ? <> <a className="mon-xlink" href={a.url} target="_blank" rel="noreferrer">{t('panels.runLink')}</a></> : null}</span>
        </div>
      ))}
      <RuleQuality v={v} />
      <div className="mon-sub">{t('panels.data.title')}</div>
      {sorted.length === 0 ? <p className="hint">{t('panels.data.empty')}</p> : <div className="mon-tile-grid">{sorted.map((d) => <DatasetCard key={d.id} d={d} v={v} />)}</div>}
      <NotOffered items={v.notUpstream} />
    </div>
  );
}

/** Attention first: failing jobs and tests before healthy datasets. */
function score(d: DatasetPanel): number {
  return (d.jobs ?? []).filter((j) => j.lastStatus === 'FAILURE').length * 10 + (d.tests?.failing.length ?? 0) * 5 + (d.lastSuccessAt === null ? 1 : 0);
}

function PlatformPanels({ v }: { v: PlatformView }) {
  const { t, locale, st } = useLabels();
  const msg = useServerMessage();
  // An alert's title / detail in the reader's language when the server coded it (i18n wave 4), else its English.
  const alertText = (a: PlatformView['alerts']['items'][number], f: 'title' | 'detail') => msg({ error: a[f], ...a.i18n?.[f] }, a[f]);
  const down = v.components.filter((c) => c.status !== 'ready');
  return (
    <div className="mon-panels">
      <div className="mon-sub">{t('panels.platform.components')} <span className="mon-sub-note">{t('panels.platform.componentsNote')}</span></div>
      <div className="mon-dq-row">
        {v.components.map((c) => (
          <span key={c.id} className={`badge${c.status === 'ready' ? ' ok' : c.status === 'degraded' ? ' warn' : ' err'}`} title={c.detail}>
            {c.id}{c.version ? ` ${c.version}` : ''} · {st(c.status)}
          </span>
        ))}
      </div>
      {down.length > 0 && <p className="hint" style={{ marginTop: 0 }}>{down.map((c) => `${c.id}: ${c.detail}`).join(' · ')}</p>}
      {v.repoGate.missing.length > 0 && (
        <div className="mon-tr err" role="alert">
          <span>{t('panels.platform.repoGate', { list: v.repoGate.missing.join(', '), path: 'POST /api/platform-admin/data-projects/<domain>/reconcile' })}</span>
        </div>
      )}

      {/* i18n-ignore — a product name and a metric name, never translated */}
      <div className="mon-sub">{t('panels.platform.pressure')} <span className="mon-sub-note">VictoriaMetrics · kubelet_stats</span></div>
      <Sources sources={{ victoriaMetrics: v.pressure.state }} />
      {v.pressure.nodes.length > 0 && (
        <div className="mon-stats">
          {v.pressure.nodes.map((n) => (
            <Stat key={n.node} label={t('panels.platform.nodeMemDisk', { node: n.node })} value={`${pct(n.memory, locale)} / ${pct(n.disk, locale)}`} tone={(n.memory ?? 0) > 0.9 || (n.disk ?? 0) > 0.85 ? 'error' : (n.memory ?? 0) > 0.8 ? 'warn' : undefined} />
          ))}
        </div>
      )}
      {(v.pressure.topMemory.length > 0 || v.pressure.topCpu.length > 0) && (
        <div className="mon-table" style={{ marginTop: 8 }}>
          <div className="mon-tr mon-th mon-tr-pjob"><span>{t('panels.platform.colPodMemory')}</span><span>{t('panels.platform.colNamespace')}</span><span>{t('panels.platform.colWorkingSet')}</span><span /></div>
          {v.pressure.topMemory.map((p) => (
            <div key={`m-${p.namespace}-${p.pod}`} className="mon-tr mon-tr-pjob"><span className="mono ellip">{p.pod}</span><span className="muted ellip">{p.namespace}</span><span>{gib(p.value, locale)}</span><span /></div>
          ))}
          <div className="mon-tr mon-th mon-tr-pjob"><span>{t('panels.platform.colPodCpu')}</span><span>{t('panels.platform.colNamespace')}</span><span>{t('panels.platform.colCores')}</span><span /></div>
          {v.pressure.topCpu.map((p) => (
            <div key={`c-${p.namespace}-${p.pod}`} className="mon-tr mon-tr-pjob"><span className="mono ellip">{p.pod}</span><span className="muted ellip">{p.namespace}</span><span>{decimals(p.value, 2, locale)}</span><span /></div>
          ))}
        </div>
      )}

      <div className="mon-sub">{t('panels.platform.errorLogs')} <span className="mon-sub-note">{t('panels.platform.errorLogsNote')}</span></div>
      <Sources sources={{ victoriaLogs: v.errorLogs.state }} />
      {v.errorLogs.state.state === 'live' && v.errorLogs.rows.length === 0 && <p className="hint">{t('panels.platform.errorLogsEmpty')}</p>}
      {v.errorLogs.rows.length > 0 && (
        <div className="mon-table">
          {v.errorLogs.rows.map((r) => (
            <div key={`${r.namespace}-${r.container}`} className="mon-tr mon-tr-pjob"><span className="mono ellip">{r.container}</span><span className="muted ellip">{r.namespace}</span><span>{count(r.errors, locale)}</span><span /></div>
          ))}
        </div>
      )}

      <div className="mon-sub">{t('panels.platform.backups')}</div>
      <Sources sources={{ backups: v.backups.state }} />
      {v.backups.state.state === 'live' && v.backups.items.length === 0 ? <p className="hint">{t('panels.platform.backupsEmpty')}</p> : v.backups.items.length > 0 && (
        <div className="mon-table">
          {v.backups.items.map((b) => (
            <div key={b.id} className={`mon-tr mon-tr-pfail${b.health === 'red' ? ' err' : ''}`}><span>{st(b.health)}</span><span className="ellip" title={b.detail}>{b.title} — {b.detail}</span><span className="muted">{b.ts ? ago(b.ts, locale) : ''}</span></div>
          ))}
        </div>
      )}

      <div className="mon-sub">{t('panels.platform.alerts')}</div>
      <Sources sources={{ alerts: v.alerts.state }} />
      {v.alerts.state.state === 'live' && v.alerts.items.length === 0 ? <p className="hint">{t('panels.platform.alertsEmpty')}</p> : v.alerts.items.length > 0 && (
        <div className="mon-table">
          {v.alerts.items.map((a) => (
            <div key={a.id} className={`mon-tr mon-tr-pfail${a.severity === 'critical' ? ' err' : ''}`}><span>{st(a.severity)}</span><span className="ellip" title={alertText(a, 'detail')}>{alertText(a, 'title')} — {alertText(a, 'detail')}</span><span className="muted">{st(a.disposition)}</span></div>
          ))}
        </div>
      )}
      <NotOffered items={v.notUpstream} />
    </div>
  );
}

const FILE_CONV: Record<FilePanel['conversion'], 'extracted' | 'pending' | 'failed' | 'notNeeded'> = { extracted: 'extracted', pending: 'pending', failed: 'failed', not_needed: 'notNeeded' };
const FILE_IDX: Record<FilePanel['indexing'], 'indexed' | 'empty' | 'failed' | 'storedOnly' | 'notIndexed'> = { indexed: 'indexed', empty: 'empty', failed: 'failed', stored_only: 'storedOnly', not_indexed: 'notIndexed' };

const DRIVE_STATE: Record<DrivePanel['state'], 'ok' | 'failed' | 'lagging' | 'paused' | 'needsReconnect' | 'neverSynced'> = { ok: 'ok', failed: 'failed', lagging: 'lagging', paused: 'paused', needs_reconnect: 'needsReconnect', never_synced: 'neverSynced' };

function DrivePanels({ d }: { d: FilesView['drives'] }) {
  const { t, locale, st } = useLabels();
  const sm = d.summary;
  const schedule = d.schedule
    ? d.schedule.status === 'RUNNING'
      ? t('panels.drives.scheduleRunning', { name: d.schedule.name, cron: d.schedule.cron, next: d.schedule.nextTickAt ? stamp(d.schedule.nextTickAt, locale) : t('panels.drives.unknown') })
      : t('panels.drives.scheduleStopped', { name: d.schedule.name })
    : '';
  const lastRun = d.lastDagsterRun
    ? d.lastDagsterRun.endedAt
      ? t('panels.drives.lastRunAgo', { status: st(d.lastDagsterRun.status), ago: ago(d.lastDagsterRun.endedAt, locale) })
      : t('panels.drives.lastRun', { status: st(d.lastDagsterRun.status) })
    : t('panels.drives.noRun');
  return (
    <>
      <div className="mon-sub">{t('panels.drives.title')} <span className="mon-sub-note">{t('panels.drives.note')}</span></div>
      <Sources sources={d.sources} />
      {d.schedule && (
        <p className="hint">{schedule} {lastRun}</p>
      )}
      {sm && (
        <div className="mon-stats">
          <Stat label={t('panels.drives.drives')} value={count(sm.connections, locale)} />
          <Stat label={t('panels.drives.state.failed')} value={count(sm.failing, locale)} tone={sm.failing ? 'error' : undefined} />
          <Stat label={t('panels.drives.state.lagging')} value={count(sm.lagging, locale)} tone={sm.lagging ? 'warn' : undefined} />
          <Stat label={t('panels.drives.state.paused')} value={count(sm.paused, locale)} tone={sm.paused ? 'warn' : undefined} />
          <Stat label={t('panels.drives.needReconnect')} value={count(sm.needsReconnect, locale)} tone={sm.needsReconnect ? 'error' : undefined} />
        </div>
      )}
      {d.connections.length === 0 ? (
        <p className="hint">{d.sources.drives.state === 'live' ? t('panels.drives.emptyLive') : t('panels.drives.emptyDown')}</p>
      ) : (
        <div className="mon-table">
          <div className="mon-tr mon-th mon-tr-pfile"><span>{t('panels.drives.colDrive')}</span><span>{t('panels.drives.colLastSync')}</span><span>{t('panels.drives.colImported')}</span><span>{t('panels.drives.colState')}</span></div>
          {d.connections.map((c) => (
            <div key={c.id} className={`mon-tr mon-tr-pfile${c.state === 'failed' || c.state === 'needs_reconnect' ? ' err' : ''}`}>
              <span className="ellip" title={c.label}><a className="mon-xlink" href={c.connectionsUrl}>{c.label}</a> <span className="muted">· {c.domain || t('panels.personal')} · {c.provider}</span></span>
              <span title={c.lastSync?.error ?? ''}>{c.lastSync
                ? c.lastSync.ok
                  ? t('panels.drives.syncOk', { ago: ago(c.lastSync.at, locale), trigger: st(c.lastSync.trigger), added: count(c.lastSync.added, locale), changed: count(c.lastSync.changed, locale), unchanged: count(c.lastSync.unchanged, locale), seconds: count(Math.round(c.lastSync.durationMs / 1000), locale) })
                  : t('panels.drives.syncFailed', { ago: ago(c.lastSync.at, locale), trigger: st(c.lastSync.trigger), error: c.lastSync.error ?? t('panels.drives.noErrorText') })
                : t('panels.never')}</span>
              <span>{t('panels.drives.imported', { count: c.filesImported, lag: c.lagMinutes === null ? t('panels.drives.noSuccess') : t('panels.drives.lagMin', { count: count(c.lagMinutes, locale) }) })}</span>
              <span title={c.paused?.reason ?? ''}>{t(`panels.drives.state.${DRIVE_STATE[c.state]}`)}{c.paused ? ` — ${c.paused.reason}` : ''}{c.failedRuns ? ` ${t('panels.drives.failedRuns', { failed: count(c.failedRuns, locale), total: count(c.historyRuns, locale) })}` : ''}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function FilesPanels({ v }: { v: FilesView }) {
  const { t, locale } = useLabels();
  const sm = v.summary;
  return (
    <div className="mon-panels">
      <div className="mon-sub">{t('panels.files.title')} <span className="mon-sub-note">{t('panels.files.note')}</span></div>
      <Sources sources={v.sources} />
      <DrivePanels d={v.drives} />
      {sm && (
        <div className="mon-stats">
          <Stat label={t('panels.files.files')} value={count(sm.total, locale)} />
          <Stat label={t('panels.files.idx.indexed')} value={count(sm.searchable, locale)} />
          <Stat label={t('panels.files.conv.failed')} value={count(sm.conversionFailed, locale)} tone={sm.conversionFailed ? 'error' : undefined} />
          <Stat label={t('panels.files.idx.failed')} value={count(sm.indexingFailed, locale)} tone={sm.indexingFailed ? 'error' : undefined} />
          <Stat label={t('panels.files.conv.pending')} value={count(sm.converting, locale)} tone={sm.converting ? 'warn' : undefined} />
          <Stat label={t('panels.files.disagree')} value={v.sources.openSearch.state === 'live' ? count(sm.disagreements, locale) : '—'} tone={sm.disagreements ? 'warn' : undefined} />
        </div>
      )}
      {Object.keys(v.conversionFailuresByCode).length > 0 && (
        <p className="hint">{t('panels.files.conversionFailures', { list: Object.entries(v.conversionFailuresByCode).map(([c, n]) => `${c} ×${count(n, locale)}`).join(' · ') })}</p>
      )}
      {v.files.length === 0 ? (
        <p className="hint">{v.sources.inventory.state === 'live' ? t('panels.files.emptyLive') : t('panels.files.emptyDown')}</p>
      ) : (
        <div className="mon-table">
          <div className="mon-tr mon-th mon-tr-pfile"><span>{t('panels.files.colFile')}</span><span>{t('panels.files.colConversion')}</span><span>{t('panels.files.colIndexing')}</span><span>{t('panels.files.colRows')}</span></div>
          {v.files.map((f) => (
            <div key={f.id} className={`mon-tr mon-tr-pfile${f.conversion === 'failed' || f.indexing === 'failed' ? ' err' : ''}`}>
              <span className="ellip" title={f.name}><a className="mon-xlink" href={f.filesUrl}>{f.name}</a> <span className="muted">· {f.domain || t('panels.personal')}</span></span>
              <span title={f.conversionFailure?.reason ?? ''}>{t(`panels.files.conv.${FILE_CONV[f.conversion]}`)}{f.conversionFailure?.code ? ` — ${f.conversionFailure.code}` : ''}</span>
              <span title={f.indexingFailure?.reason ?? ''}>{t(`panels.files.idx.${FILE_IDX[f.indexing]}`)}</span>
              <span>{f.openSearchRows === undefined ? '—' : count(f.openSearchRows, locale)}{f.agreement === 'missing_in_index' ? ` ${t('panels.files.missingInIndex')}` : f.agreement === 'unrecorded_rows' ? ` ${t('panels.files.unrecordedRows')}` : ''}</span>
            </div>
          ))}
        </div>
      )}
      {v.truncated && <p className="hint">{t('panels.files.truncated')}</p>}
      <NotOffered items={v.notUpstream} />
    </div>
  );
}

const KN_STATE: Record<NonNullable<KnowledgeView['workflows'][number]['index']>['state'], 'indexed' | 'stale' | 'notIndexed' | 'draftNotIndexed'> = { indexed: 'indexed', stale: 'stale', not_indexed: 'notIndexed', draft_not_indexed: 'draftNotIndexed' };

function KnowledgePanels({ v }: { v: KnowledgeView }) {
  const { t, locale, st } = useLabels();
  const sm = v.summary;
  return (
    <div className="mon-panels">
      <div className="mon-sub">{t('panels.knowledge.title')} <span className="mon-sub-note">{t('panels.knowledge.note')}</span></div>
      <Sources sources={v.sources} />
      {sm && (
        <div className="mon-stats">
          <Stat label={t('panels.knowledge.workflows')} value={count(sm.total, locale)} />
          <Stat label={t('panels.knowledge.indexed')} value={count(sm.indexed, locale)} />
          <Stat label={t('panels.knowledge.stale')} value={count(sm.stale, locale)} tone={sm.stale ? 'warn' : undefined} />
          <Stat label={t('panels.knowledge.notIndexed')} value={count(sm.notIndexed, locale)} tone={sm.notIndexed ? 'error' : undefined} />
          {v.searchLatency !== undefined && <Stat label={t('panels.knowledge.avgSearch')} value={v.searchLatency.avgMs !== null ? ms(v.searchLatency.avgMs, locale) : '—'} />}
          {v.searchLatencyUnavailable && <Stat label={t('panels.knowledge.avgSearch')} value={st('unavailable')} tone="warn" />}
        </div>
      )}
      {v.workflows.length === 0 ? (
        <p className="hint">{v.sources.inventory.state === 'live' ? t('panels.knowledge.emptyLive') : t('panels.knowledge.emptyDown')}</p>
      ) : (
        <div className="mon-table">
          <div className="mon-tr mon-th mon-tr-pfile"><span>{t('panels.knowledge.colWorkflow')}</span><span>{t('panels.knowledge.colIndex')}</span><span>{t('panels.knowledge.colRows')}</span><span>{t('panels.knowledge.colLastIndexed')}</span></div>
          {v.workflows.map((w) => (
            <div key={w.id} className={`mon-tr mon-tr-pfile${w.index?.state === 'not_indexed' ? ' err' : ''}`}>
              <span className="ellip" title={w.title}><a className="mon-xlink" href={w.knowledgeUrl}>{w.title}</a> <span className="muted">· {w.domain || t('panels.personal')} · {st(w.status)}</span></span>
              <span>{w.index ? t(`panels.knowledge.state.${KN_STATE[w.index.state]}`) : '—'}</span>
              <span>{w.index ? count(w.index.rows, locale) : '—'}</span>
              <span className="muted">{w.index?.lastIndexedAt ? ago(w.index.lastIndexedAt, locale) : '—'}</span>
            </div>
          ))}
        </div>
      )}
      <NotOffered items={v.notUpstream} />
    </div>
  );
}

function KpisPanels({ v }: { v: KpisView }) {
  const { t, locale } = useLabels();
  const sm = v.summary;
  return (
    <div className="mon-panels">
      <div className="mon-sub">{t('panels.kpis.title')} <span className="mon-sub-note">{t('panels.kpis.note')}</span></div>
      <Sources sources={v.sources} />
      {sm && (
        <div className="mon-stats">
          <Stat label={t('panels.kpis.metrics')} value={count(sm.metrics, locale)} />
          <Stat label={t('panels.kpis.cannotRead')} value={count(sm.loadErrors, locale)} tone={sm.loadErrors ? 'error' : undefined} />
          <Stat label={t('panels.kpis.alertsFiring')} value={count(sm.alertsFiring, locale)} tone={sm.alertsFiring ? 'error' : undefined} />
          <Stat label={t('panels.kpis.evalFailed')} value={v.sources.dagster.state === 'live' ? count(sm.alertsFailing, locale) : '—'} tone={sm.alertsFailing ? 'warn' : undefined} />
        </div>
      )}
      <div className="mon-sub">{t('panels.kpis.alerts')}</div>
      {v.alerts.length === 0 ? <p className="hint">{v.sources.alerts.state === 'live' ? t('panels.kpis.alertsEmptyLive') : t('panels.kpis.alertsEmptyDown')}</p> : (
        <div className="mon-table">
          <div className="mon-tr mon-th mon-tr-pfile"><span>{t('panels.kpis.colRule')}</span><span>{t('panels.kpis.colState')}</span><span>{t('panels.kpis.colLastValue')}</span><span>{t('panels.kpis.colEvaluations')}</span></div>
          {v.alerts.map((a) => (
            <div key={a.id} className={`mon-tr mon-tr-pfile${a.firing ? ' err' : ''}`}>
              <span className="ellip" title={a.member}><span className="mono">{a.member}</span> {a.condition} <span className="muted">· {a.domain}</span></span>
              <span><span className={`badge${a.firing ? ' err' : a.lastEvaluated ? ' ok' : ' muted'}`}>{a.firing ? t('panels.kpis.firing') : a.lastEvaluated ? t('panels.kpis.ok') : t('panels.kpis.neverEvaluated')}</span>{a.lastEvaluated ? <span className="muted"> {ago(a.lastEvaluated, locale)}</span> : null}</span>
              <span>{a.lastValue === undefined ? '—' : typeof a.lastValue === 'number' ? count(a.lastValue, locale) : String(a.lastValue)}</span>
              <span>{a.evaluations === undefined ? '—' : a.evaluations.runs === 0 ? t('panels.kpis.noRunInWindow') : t('panels.kpis.evaluations', { failures: count(a.evaluations.failures, locale), runs: count(a.evaluations.runs, locale) })}{a.evaluations?.lastFailureUrl ? <> <a className="mon-xlink" href={a.evaluations.lastFailureUrl} target="_blank" rel="noreferrer">{t('panels.runLink')}</a></> : null}</span>
            </div>
          ))}
        </div>
      )}
      <div className="mon-sub">{t('panels.kpis.metricsTitle')}</div>
      {v.metrics.length === 0 ? <p className="hint">{v.sources.inventory.state === 'live' ? t('panels.kpis.metricsEmptyLive') : t('panels.kpis.metricsEmptyDown')}</p> : (
        <div className="mon-table">
          <div className="mon-tr mon-th mon-tr-pfile"><span>{t('panels.kpis.colMetric')}</span><span>{t('panels.kpis.colDataBuilt')}</span><span>{t('panels.kpis.colAlertsFiring')}</span><span>{t('panels.kpis.colStatus')}</span></div>
          {v.metrics.map((m) => (
            <div key={m.id} className={`mon-tr mon-tr-pfile${m.loadError ? ' err' : ''}`}>
              <span className="ellip" title={m.name}><a className="mon-xlink" href={m.kpisUrl}>{m.name}</a> <span className="muted">· {m.datasetName}</span></span>
              <span className="muted">{m.dataLastSuccessAt === undefined ? '—' : m.dataLastSuccessAt ? ago(m.dataLastSuccessAt, locale) : t('panels.kpis.noSuccessInWindow')}</span>
              <span>{count(m.alertsFiring, locale)}</span>
              <span title={m.loadError ?? ''}>{m.loadError ? t('panels.kpis.cannotReadError', { error: m.loadError }) : t('panels.kpis.readable')}</span>
            </div>
          ))}
        </div>
      )}
      <NotOffered items={v.notUpstream} />
    </div>
  );
}

function DashboardsPanels({ v }: { v: DashboardsView }) {
  const { t, locale } = useLabels();
  const sm = v.summary;
  return (
    <div className="mon-panels">
      <div className="mon-sub">{t('panels.dashboards.title')} <span className="mon-sub-note">{t('panels.dashboards.note')}</span></div>
      <Sources sources={v.sources} />
      {sm && (
        <div className="mon-stats">
          <Stat label={t('panels.dashboards.dashboards')} value={count(sm.dashboards, locale)} />
          <Stat label={t('panels.dashboards.withBroken')} value={count(sm.withBrokenReferences, locale)} tone={sm.withBrokenReferences ? 'error' : undefined} />
          <Stat label={t('panels.dashboards.brokenPanels')} value={count(sm.brokenPanels, locale)} tone={sm.brokenPanels ? 'error' : undefined} />
        </div>
      )}
      {v.dashboards.length === 0 ? <p className="hint">{v.sources.inventory.state === 'live' ? t('panels.dashboards.emptyLive') : t('panels.dashboards.emptyDown')}</p> : (
        <div className="mon-table">
          <div className="mon-tr mon-th mon-tr-pfile"><span>{t('panels.dashboards.colDashboard')}</span><span>{t('panels.dashboards.colView')}</span><span>{t('panels.dashboards.colPanels')}</span><span>{t('panels.dashboards.colBroken')}</span></div>
          {v.dashboards.map((d) => (
            <div key={d.id} className={`mon-tr mon-tr-pfile${d.broken.length || !d.viewServed ? ' err' : ''}`}>
              <span className="ellip" title={d.name}><a className="mon-xlink" href={d.dashboardsUrl}>{d.name}</a> <span className="muted">· {d.domain || t('panels.personal')}</span></span>
              <span className="mono ellip">{d.view}{d.viewServed ? '' : ` ${t('panels.dashboards.notServedSuffix')}`}</span>
              <span>{count(d.panels, locale)}</span>
              <span>{d.broken.length === 0 ? (d.viewServed ? t('panels.dashboards.none') : t('panels.dashboards.viewNotServed')) : d.broken.map((b) => `${b.panel}: ${b.missing.join(', ')}`).join(' · ')}</span>
            </div>
          ))}
        </div>
      )}
      <NotOffered items={v.notUpstream} />
    </div>
  );
}

const SCAN_VERDICT: Record<NonNullable<SoftwareApp['scan']>['verdict'], 'passed' | 'failed' | 'noVerdict'> = { passed: 'passed', failed: 'failed', no_verdict: 'noVerdict' };
const POD_STATE = { running: 'running', starting: 'starting', crash_looping: 'crashLooping', image_pull_failed: 'imagePullFailed', failed: 'failed', completed: 'completed', not_ready: 'notReady', no_pods: 'noPods' } as const;
const podStateKey = (s: string) => (Object.prototype.hasOwnProperty.call(POD_STATE, s) ? POD_STATE[s as keyof typeof POD_STATE] : null);

function SoftwarePanels({ v }: { v: SoftwareView }) {
  const { t, locale, number, st } = useLabels();
  const sm = v.summary;
  const scanText = (a: SoftwareApp): string => {
    if (!a.scan) return t('panels.software.noScan');
    const s = a.scan;
    return `${t(`panels.software.verdict.${SCAN_VERDICT[s.verdict]}`)}${s.engine ? ` (${s.engine})` : ''} · ${t('panels.software.severities', { critical: count(s.bySeverity.critical, locale), high: count(s.bySeverity.high, locale), medium: count(s.bySeverity.medium, locale) })}${s.truncated ? ` ${t('panels.software.listedOnly')}` : ''}${s.notRun.length ? ` ${t('panels.software.notCovered', { list: s.notRun.join(', ') })}` : ''}`;
  };
  const podText = (a: SoftwareApp): string => {
    if (!a.pods) return a.serveMode === 'image' ? '—' : t('panels.software.servedByOs');
    const k = podStateKey(a.pods.state);
    const restarts = a.pods.items.reduce((n, p) => n + p.restarts, 0);
    return `${k ? t(`panels.software.pod.${k}`) : a.pods.state}${a.pods.items.some((p) => p.restarts) ? ` ${t('panels.software.restarts', { count: restarts })}` : ''}`;
  };
  return (
    <div className="mon-panels">
      <div className="mon-sub">{t('panels.software.title')} <span className="mon-sub-note">{t('panels.software.note')}</span></div>
      <Sources sources={v.sources} />
      {sm && (
        <div className="mon-stats">
          <Stat label={t('panels.software.apps')} value={count(sm.apps, locale)} />
          <Stat label={t('panels.software.serving')} value={count(sm.serving, locale)} />
          <Stat label={t('panels.software.scanFailed')} value={count(sm.scanFailed, locale)} tone={sm.scanFailed ? 'error' : undefined} />
          <Stat label={t('panels.software.scanNoVerdict')} value={count(sm.noVerdict, locale)} tone={sm.noVerdict ? 'warn' : undefined} />
          <Stat label={t('panels.software.podsUnhealthy')} value={v.sources.pods.state === 'live' ? count(sm.podsUnhealthy, locale) : '—'} tone={sm.podsUnhealthy ? 'error' : undefined} />
        </div>
      )}
      {v.apps.length === 0 ? (
        <p className="hint">{v.sources.inventory.state === 'live' ? t('panels.software.emptyLive') : t('panels.software.emptyDown')}</p>
      ) : (
        <div className="mon-table">
          <div className="mon-tr mon-th mon-tr-pfile"><span>{t('panels.software.colApp')}</span><span>{t('panels.software.colStatus')}</span><span>{t('panels.software.colScan')}</span><span>{t('panels.software.colPods')}</span></div>
          {v.apps.map((a) => (
            <div key={a.id} className={`mon-tr mon-tr-pfile${a.scan?.verdict === 'failed' || (a.pods && ['crash_looping', 'image_pull_failed', 'failed'].includes(a.pods.state)) ? ' err' : ''}`}>
              <span className="ellip" title={a.name}><a className="mon-xlink" href={a.softwareUrl}>{a.name}</a> <span className="muted">· {a.domain || t('panels.personal')}</span></span>
              <span>{a.status.label}{a.review ? ` · ${st(a.review.decision)}` : ` · ${t('panels.software.neverReviewed')}`} · {a.ci.state === 'recorded' ? t('panels.software.checks', { overall: st(a.ci.overall), engine: a.ci.engine, sha: a.ci.sha.slice(0, 7) }) : t('panels.software.checksNone')}</span>
              <span title={a.scan?.reason ?? ''}>{scanText(a)}</span>
              <span>{podText(a)} · {a.logs ? (a.logs.errorRate === null ? t('panels.software.noLogLines') : t('panels.software.errorLines', { errors: count(a.logs.errors, locale), lines: count(a.logs.lines, locale), rate: number(a.logs.errorRate, { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 }) })) : '—'}</span>
            </div>
          ))}
        </div>
      )}
      <NotOffered items={v.notUpstream} />
    </div>
  );
}

const LIFECYCLE: Record<WorkflowsView['workflows'][number]['lifecycle'], 'draft' | 'live' | 'stale'> = { draft: 'draft', live: 'live', stale: 'stale' };

function WorkflowsPanels({ v }: { v: WorkflowsView }) {
  const { t, locale } = useLabels();
  const sm = v.summary;
  const d = v.approvals.decided;
  return (
    <div className="mon-panels">
      <div className="mon-sub">{t('panels.workflows.title')} <span className="mon-sub-note">{t('panels.workflows.note')}</span></div>
      <Sources sources={v.sources} />
      {sm && (
        <div className="mon-stats">
          <Stat label={t('panels.workflows.workflows')} value={count(sm.total, locale)} />
          <Stat label={t('panels.workflows.live')} value={count(sm.live, locale)} />
          <Stat label={t('panels.workflows.drafts')} value={count(sm.draft, locale)} />
          <Stat label={t('panels.workflows.lifecycle.stale')} value={count(sm.stale, locale)} tone={sm.stale ? 'warn' : undefined} />
          <Stat label={t('panels.workflows.requestsWaiting')} value={sm.pendingApprovals === null ? '—' : count(sm.pendingApprovals, locale)} tone={sm.pendingApprovals ? 'warn' : undefined} />
          <Stat label={t('panels.workflows.oldestWait')} value={sm.oldestWaitHours === null ? '—' : t('panels.workflows.hours', { hours: count(sm.oldestWaitHours, locale) })} />
        </div>
      )}
      {v.approvals.pending.length > 0 && (
        <div className="mon-table">
          <div className="mon-tr mon-th mon-tr-pfile"><span>{t('panels.workflows.colRequest')}</span><span>{t('panels.workflows.colAskedBy')}</span><span>{t('panels.workflows.colNeeds')}</span><span>{t('panels.workflows.colWaiting')}</span></div>
          {v.approvals.pending.map((a) => (
            <div key={a.id} className="mon-tr mon-tr-pfile">
              <span className="ellip" title={a.title}><a className="mon-xlink" href={a.approvalsUrl}>{a.title}</a> <span className="muted">· {a.domain}</span></span>
              <span>{a.requestedBy}</span>
              <span>{a.approverRole.replace('_', ' ')}{a.kind === 'promote_certify' ? ` ${t('panels.workflows.company')}` : ''}</span>
              <span>{t('panels.workflows.hours', { hours: count(a.waitingHours, locale) })}</span>
            </div>
          ))}
        </div>
      )}
      {v.sources.approvals.state === 'live' && <p className="hint">{d.medianWaitHours === null
        ? t('panels.workflows.decided', { days: d.windowDays, count: count(d.count, locale) })
        : t('panels.workflows.decidedMedian', { days: d.windowDays, count: count(d.count, locale), hours: count(d.medianWaitHours, locale) })}</p>}
      {v.workflows.length === 0 ? (
        <p className="hint">{v.sources.inventory.state === 'live' ? t('panels.workflows.emptyLive') : t('panels.workflows.emptyDown')}</p>
      ) : (
        <div className="mon-table">
          <div className="mon-tr mon-th mon-tr-pfile"><span>{t('panels.workflows.colWorkflow')}</span><span>{t('panels.workflows.colState')}</span><span>{t('panels.workflows.colLastEdited')}</span><span>{t('panels.workflows.colCertified')}</span></div>
          {v.workflows.map((w) => (
            <div key={w.id} className={`mon-tr mon-tr-pfile${w.lifecycle === 'stale' ? ' err' : ''}`}>
              <span className="ellip" title={w.title}><a className="mon-xlink" href={w.workflowUrl}>{w.title}</a> <span className="muted">· {w.domain || t('panels.personal')}</span></span>
              <span>{t(`panels.workflows.lifecycle.${LIFECYCLE[w.lifecycle]}`)}</span>
              <span>{ago(w.updatedAt, locale)}</span>
              <span>{w.certified ? t('panels.workflows.yes') : '—'}</span>
            </div>
          ))}
        </div>
      )}
      <p className="hint">{t('panels.workflows.staleDef', { definition: v.definitions.stale })}</p>
      <NotOffered items={v.notUpstream} />
    </div>
  );
}

export default function PanelsView({ kind }: { kind: PanelKind }) {
  const t = useTranslations('monitoring');
  const { data, loading, error } = useApi<AgentsView | DataView | PlatformView | FilesView | KnowledgeView | KpisView | DashboardsView | SoftwareView | WorkflowsView>(`/api/monitoring/panels?view=${kind}`);
  if (error) return <div className="error" style={{ marginTop: 12 }}>{error}</div>;
  if (!data) return loading ? <div className="hint" style={{ marginTop: 12 }}><span className="spin" /> {t('panels.reading')}</div> : null;
  if (data.view === 'agents') return <AgentsPanels v={data} />;
  if (data.view === 'data') return <DataPanels v={data} />;
  if (data.view === 'files') return <FilesPanels v={data} />;
  if (data.view === 'knowledge') return <KnowledgePanels v={data} />;
  if (data.view === 'kpis') return <KpisPanels v={data} />;
  if (data.view === 'dashboards') return <DashboardsPanels v={data} />;
  if (data.view === 'software') return <SoftwarePanels v={data} />;
  if (data.view === 'workflows') return <WorkflowsPanels v={data} />;
  return <PlatformPanels v={data} />;
}
