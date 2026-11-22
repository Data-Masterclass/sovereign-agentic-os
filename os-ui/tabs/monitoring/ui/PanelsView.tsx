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
 */
'use client';

import { useMemo, useState } from 'react';
import { useApi } from '@core/ui/useApi';
import type { AgentsView, AgentSystemPanel } from '@tabs/monitoring/lib/panels/agents-panel';
import type { DataView, DatasetPanel, RulePanel } from '@tabs/monitoring/lib/panels/data-panel';
import type { PlatformView } from '@tabs/monitoring/lib/panels/platform-panel';
import type { FilesView, FilePanel, DrivePanel } from '@tabs/monitoring/lib/panels/files-panel';
import type { KnowledgeView } from '@tabs/monitoring/lib/panels/knowledge-panel';
import type { KpisView } from '@tabs/monitoring/lib/panels/kpis-panel';
import type { DashboardsView } from '@tabs/monitoring/lib/panels/dashboards-panel';
import type { NotUpstream, SourceState } from '@tabs/monitoring/lib/panels/panels-core';
import { ago, compact, usd } from '@tabs/monitoring/ui/format';

export type PanelKind = 'agents' | 'data' | 'platform' | 'files' | 'knowledge' | 'kpis' | 'dashboards';

const ms = (v: number | null | undefined): string => (v === null || v === undefined ? '—' : v >= 10_000 ? `${(v / 1000).toFixed(0)} s` : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);
const pct = (v: number | null | undefined): string => (v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`);
const bytes = (v: number): string => (v >= 1 << 30 ? `${(v / (1 << 30)).toFixed(1)} GiB` : `${Math.round(v / (1 << 20))} MiB`);

function Sources({ sources }: { sources: Record<string, SourceState> }) {
  const down = Object.entries(sources).filter(([, s]) => s.state !== 'live');
  if (down.length === 0) return null;
  return (
    <div className="mon-dq-row" style={{ marginBottom: 10 }}>
      {down.map(([k, s]) => (
        <span key={k} className="badge warn" title={'reason' in s ? s.reason : ''}>
          {k}: {s.state === 'unavailable' ? 'not reachable' : 'not offered'} — {'reason' in s ? s.reason : ''}
        </span>
      ))}
    </div>
  );
}

function NotOffered({ items }: { items: NotUpstream[] }) {
  if (!items.length) return null;
  return (
    <>
      <div className="mon-sub">Not available upstream</div>
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
    <div className="mon-spark" aria-label="Runs per day">
      <svg viewBox="0 0 100 44" preserveAspectRatio="none" role="img">
        {cols.map((c, i) => {
          let y = 44;
          return parts.map(([k, color]) => {
            const n = c[k] as number;
            if (!n) return null;
            const h = (n / max) * 42;
            y -= h;
            return <rect key={`${c.day}-${k}`} x={i * w + w * 0.15} y={y} width={w * 0.7} height={h} fill={color}><title>{`${c.day}: ${n} ${k}`}</title></rect>;
          });
        })}
      </svg>
      <div className="mon-spark-foot"><span>{cols[0]?.day}</span><span>runs per day · done · held · failed</span><span>{cols.at(-1)?.day}</span></div>
    </div>
  );
}

function AgentCard({ s, v }: { s: AgentSystemPanel; v: AgentsView }) {
  const runs = s.runs;
  const totals = runs ? runs.days.reduce((a, d) => ({ done: a.done + d.done, failed: a.failed + d.failed, held: a.held + d.held }), { done: 0, failed: 0, held: 0 }) : null;
  const t = s.traces;
  return (
    <div className="mon-stat" style={{ padding: '14px 16px' }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <b>{s.name}</b>
        <span>
          <a className="mon-xlink" href={s.agentsUrl}>Agents →</a>{' '}
          {v.links.langfuse && <a className="mon-xlink" href={`${v.links.langfuse}`} target="_blank" rel="noreferrer">Langfuse ↗</a>}
        </span>
      </div>
      {s.keyDrift && (
        <p className={`hint ${s.keyDrift.action === 'corrected' ? '' : 'err'}`} role="alert" style={{ margin: '6px 0 0' }}>
          <b>Model key {s.keyDrift.action === 'corrected' ? 'was out of line and has been put back' : 'differs from this system\'s definition'}</b> (since {ago(s.keyDrift.since)}): {s.keyDrift.changes.join('; ')}.{' '}
          {s.keyDrift.action === 'alert' && 'Someone changed it in the gateway; an admin can re-apply it from Admin → Gateway.'}
          {s.keyDrift.action === 'correction-failed' && 'Automatic correction failed; see Admin → Gateway.'}
        </p>
      )}
      {runs ? <RunBars days={runs.days} windowDays={v.runWindowDays} /> : <p className="hint">Runs: —</p>}
      <div className="mon-stats" style={{ marginTop: 10 }}>
        <Stat label={`runs ok (${v.runWindowDays}d)`} value={totals ? String(totals.done) : '—'} />
        <Stat label="failed" value={totals ? String(totals.failed) : '—'} tone={totals?.failed ? 'error' : undefined} />
        <Stat label="held for approval" value={totals ? String(totals.held) : '—'} tone={totals?.held ? 'warn' : undefined} />
        <Stat label={`p50 / p95 (${v.windowDays}d)`} value={t === undefined ? '—' : t ? `${ms(t.p50Ms)} / ${ms(t.p95Ms)}` : 'no traces'} />
        <Stat label="tokens" value={t === undefined ? '—' : t ? compact(t.tokens) : '0'} />
        <Stat label="key spend (LiteLLM, USD)" value={s.keySpendUsd === undefined ? '—' : s.keySpendUsd === null ? 'no key' : usd(s.keySpendUsd)} />
      </div>
      <div className="mon-dq-row" style={{ marginTop: 6 }}>
        {s.policy !== undefined && (
          <>
            <span className={`badge${s.policy?.denies ? ' err' : ' muted'}`} title="OPA decision log">OPA deny · {s.policy?.denies ?? 0}</span>
            <span className={`badge${s.policy?.held ? ' warn' : ' muted'}`} title="OPA decision log">approval required · {s.policy?.held ?? 0}</span>
          </>
        )}
        {runs && <span className={`badge${runs.failureClasses.budget_exceeded ? ' err' : ' muted'}`} title="LiteLLM budget_exceeded">budget exceeded · {runs.failureClasses.budget_exceeded}</span>}
        {runs && <span className={`badge${runs.failureClasses.other ? ' err' : ' muted'}`}>other failure · {runs.failureClasses.other}</span>}
        {s.approvalsWaiting && <span className={`badge${s.approvalsWaiting.length ? ' warn' : ' muted'}`}>approvals waiting · {s.approvalsWaiting.length}</span>}
      </div>
      {s.policy && s.policy.byTool.filter((x) => x.effect !== 'allow').length > 0 && (
        <p className="hint" style={{ margin: '2px 0 6px' }}>
          Denied / held tools: {s.policy.byTool.filter((x) => x.effect !== 'allow').slice(0, 4).map((x) => `${x.tool} (${x.effect} ×${x.n})`).join(' · ')}
        </p>
      )}
      {s.approvalsWaiting && s.approvalsWaiting.length > 0 && (
        <p className="hint" style={{ margin: '2px 0 6px' }}>
          Waiting: {s.approvalsWaiting.slice(0, 3).map((a) => `${a.title} (${ago(a.createdAt)})`).join(' · ')} — <a href="/governance">decide in Governance</a>
        </p>
      )}
      {runs && runs.lastFailures.length > 0 && (
        <div className="mon-table" style={{ marginTop: 6 }}>
          {runs.lastFailures.map((f) => (
            <div key={f.runId} className="mon-tr mon-tr-pfail err">
              <span className="muted">{ago(f.at)}</span>
              <span className="ellip" title={f.reason}>{f.node ? `${f.node}: ` : ''}{f.reason || 'failed'}</span>
              <span>
                {f.traceUrl && <a className="mon-xlink" href={f.traceUrl} target="_blank" rel="noreferrer">trace ↗</a>}{' '}
                <a className="mon-xlink" href={f.runUrl}>runs</a>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AgentsPanels({ v }: { v: AgentsView }) {
  return (
    <div className="mon-panels">
      <div className="mon-sub">Agent systems <span className="mon-sub-note">run store · Langfuse metrics · LiteLLM keys · OPA decision log</span></div>
      <Sources sources={v.sources} />
      {v.systems.length === 0 ? (
        <p className="hint">No agent systems in your scope.</p>
      ) : (
        <div className="mon-tile-grid">{v.systems.map((s) => <AgentCard key={s.id} s={s} v={v} />)}</div>
      )}
      <NotOffered items={v.notUpstream} />
    </div>
  );
}

function DatasetCard({ d, v }: { d: DatasetPanel; v: DataView }) {
  const failingJobs = (d.jobs ?? []).filter((j) => j.lastStatus === 'FAILURE');
  const last = d.trend?.at(-1);
  return (
    <div className="mon-stat" style={{ padding: '14px 16px' }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <b>{d.name}</b>
        <span>
          <a className="mon-xlink" href={d.dataUrl}>Data →</a>{' '}
          {d.testedAssetUrl && <a className="mon-xlink" href={d.testedAssetUrl} target="_blank" rel="noreferrer">Dagster ↗</a>}
        </span>
      </div>
      <div className="mon-stats" style={{ marginTop: 10 }}>
        <Stat label="last success" value={d.lastSuccessAt === undefined ? '—' : d.lastSuccessAt ? ago(d.lastSuccessAt) : 'never'} tone={d.lastSuccessAt === null ? 'warn' : undefined} />
        <Stat label="failing jobs" value={d.jobs ? String(failingJobs.length) : '—'} tone={failingJobs.length ? 'error' : undefined} />
        <Stat label="tests failing" value={d.tests && !d.tests.unavailable ? `${d.tests.failing.length} / ${d.tests.total}` : '—'} tone={d.tests?.failing.length ? 'error' : undefined} />
        <Stat label="quality (last run)" value={last ? `${last.passed}/${last.total}` : '—'} />
      </div>
      {d.trend && d.trend.length > 1 && (
        <p className="hint" style={{ margin: '2px 0 6px' }}>Trend (checks passed per run): {d.trend.map((p) => `${p.passed}/${p.total}`).join(' → ')}</p>
      )}
      {d.tests?.unavailable && (
        <p className="hint" style={{ margin: '2px 0 6px' }}>
          Test results unavailable — {d.tests.unavailable.reason}.
          {d.tests.unavailable.lastKnown ? ` Last known (not current): ${d.tests.unavailable.lastKnown.badge} as of ${d.tests.unavailable.lastKnown.ranAt}.` : ' No earlier result on record.'}
        </p>
      )}
      {d.tests && d.tests.failing.length > 0 && (
        <p className="hint" style={{ margin: '2px 0 6px' }}>
          Failing: {d.tests.failing.map((f) => `${f.name}${f.violations !== null ? ` (${f.violations} rows)` : ''}`).join(' · ')}
          {d.tests.source === 'os' ? ' — OS probe, no dbt test has run yet' : ''}
        </p>
      )}
      {(d.laneAlerts?.length ?? 0) > 0 && (
        <div className="mon-tr err" role="alert" style={{ marginTop: 6 }}>
          <span>Alert: {d.laneAlerts!.length} run(s) selected a model outside the owner&apos;s lane. Latest: {d.laneAlerts![0].models.join(', ')}{d.laneAlerts![0].hidden ? ` (+${d.laneAlerts![0].hidden} not visible to you)` : ''}
            {d.laneAlerts![0].url ? <> <a className="mon-xlink" href={d.laneAlerts![0].url} target="_blank" rel="noreferrer">run ↗</a></> : null}</span>
        </div>
      )}
      {d.tests && d.tests.warning?.length > 0 && (
        <p className="hint" style={{ margin: '2px 0 6px' }}>
          Warnings (dbt severity warn): {d.tests.warning.map((f) => `${f.name}${f.violations !== null ? ` (${f.violations} rows)` : ''}`).join(' · ')}
        </p>
      )}
      {(d.jobs?.length ?? 0) + (d.schedules?.length ?? 0) > 0 && (
        <div className="mon-table" style={{ marginTop: 6 }}>
          <div className="mon-tr mon-th mon-tr-pjob"><span>Job / schedule</span><span>Last</span><span>Last success</span><span>Fails</span></div>
          {[...(d.jobs ?? []).map((j) => ({ ...j, kind: 'job' })), ...(d.schedules ?? []).map((s) => ({ ...s, kind: 'schedule' }))].map((j) => (
            <div key={`${j.kind}-${j.name}`} className={`mon-tr mon-tr-pjob${j.lastStatus === 'FAILURE' ? ' err' : ''}`}>
              <span className="mono ellip" title={j.name}>{j.kind === 'schedule' ? '⏱ ' : ''}{j.name}</span>
              <span>
                {'lastFailureUrl' in j && j.lastFailureUrl && j.lastStatus === 'FAILURE'
                  ? <a className="mon-xlink" href={String(j.lastFailureUrl)} target="_blank" rel="noreferrer">{j.lastStatus.toLowerCase()} ↗</a>
                  : j.lastStatus.toLowerCase()}
              </span>
              <span className="muted">{j.lastSuccessAt ? ago(j.lastSuccessAt) : 'never'}</span>
              <span>{j.failures}/{j.runs}</span>
            </div>
          ))}
        </div>
      )}
      {d.downstream && d.downstream.length > 0 && (d.tests?.failing.length || failingJobs.length) ? (
        <p className="hint" style={{ margin: '6px 0 0' }}>
          Impacted downstream: {d.downstream.slice(0, 6).map((k, i) => (
            <span key={k.key}>{i ? ' · ' : ''}{k.url ? <a href={k.url} target="_blank" rel="noreferrer">{k.key}</a> : k.key}</span>
          ))}{d.downstream.length > 6 ? ` +${d.downstream.length - 6}` : ''}
        </p>
      ) : d.downstream && d.downstream.length > 0 ? (
        <p className="hint" style={{ margin: '6px 0 0' }}>Downstream: {d.downstream.length} asset{d.downstream.length === 1 ? '' : 's'}</p>
      ) : null}
      {d.downstreamHidden && (
        <p className="hint" style={{ margin: '4px 0 0' }}>
          {d.tests?.failing.length || failingJobs.length ? 'Also impacted' : 'Also downstream'}: {d.downstreamHidden.count} asset{d.downstreamHidden.count === 1 ? '' : 's'} outside your view
        </p>
      )}
      {v.sources.dagsterRuns.state === 'live' && (d.jobs?.length ?? 0) === 0 && <p className="hint" style={{ margin: '6px 0 0' }}>No Dagster runs for this dataset in the recent run window.</p>}
    </div>
  );
}

type FlatRule = RulePanel & { datasetId: string; datasetName: string; domain: string; dataUrl: string };
const RULE_ORDER: Record<RulePanel['status'], number> = { fail: 0, warn: 1, unavailable: 2, not_run: 3, pass: 4 };

/** Data quality per rule and per dataset — failing rules first; filter by domain and dataset. */
function RuleQuality({ v }: { v: DataView }) {
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
      <div className="mon-sub">Data quality by rule <span className="mon-sub-note">dbt tests as Dagster asset checks · failing first</span></div>
      <div className="mon-stats">
        <Stat label="rules" value={String(all.length)} />
        <Stat label="failing" value={String(failing)} tone={failing ? 'error' : undefined} />
        <Stat label="warning" value={String(warning)} tone={warning ? 'warn' : undefined} />
        {unreadable > 0 && <Stat label="unavailable" value={String(unreadable)} tone="warn" />}
      </div>
      {v.rulesDatasetsOmitted > 0 && <p className="hint">Per-rule results of {v.rulesDatasetsOmitted} more dataset(s) are not read in this response (limit); their latest status is in the dataset cards.</p>}
      {all.length === 0 ? (
        <p className="hint">{v.sources.tests.state === 'live' ? 'No dbt test has run in Dagster for your datasets yet.' : 'Rule results are not available while Dagster does not answer.'}</p>
      ) : (
        <>
          <div className="mon-dq-row" style={{ marginBottom: 8 }}>
            <select aria-label="Filter by domain" value={domain} onChange={(e) => { setDomain(e.target.value); setDataset(''); }}>
              <option value="">All domains</option>
              {domains.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
            <select aria-label="Filter by dataset" value={dataset} onChange={(e) => setDataset(e.target.value)}>
              <option value="">All datasets</option>
              {datasets.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
          </div>
          <div className="mon-table">
            <div className="mon-tr mon-th mon-tr-prule"><span>Rule</span><span>Status</span><span>Failing rows</span><span>Last run</span><span>Failing since</span><span>Trend</span></div>
            {rows.map((r) => (
              <div key={`${r.datasetId}-${r.name}`} className={`mon-tr mon-tr-prule${r.status === 'fail' ? ' err' : ''}`}>
                <span className="ellip" title={r.name}>
                  <span className="mono">{r.name}</span> <span className="badge muted">{r.type}</span>
                  <br /><a className="mon-xlink" href={r.dataUrl}>{r.datasetName}</a> <span className="muted">· {r.domain}</span>
                </span>
                <span>
                  <span className={`badge${tone(r.status)}`}>{r.status === 'not_run' ? 'not run' : r.status}{r.severity ? ` · ${r.severity}` : ''}</span>
                  {r.status === 'unavailable' && (
                    <span className="hint" style={{ display: 'block', margin: '2px 0 0' }}>
                      {r.unavailableReason}
                      {r.lastRecorded && ` · last recorded: ${r.lastRecorded.status === 'not_run' ? 'not run' : r.lastRecorded.status}${r.lastRecorded.failingRows !== undefined ? ` (${r.lastRecorded.failingRows} rows)` : ''}${r.lastRecorded.at ? `, ${r.lastRecorded.at}` : ''}`}
                    </span>
                  )}
                </span>
                <span>{r.status === 'fail' || r.status === 'warn' ? (r.failingRows !== undefined ? String(r.failingRows) : '—') : ''}</span>
                <span className="muted">
                  {r.lastRunAt ? ago(r.lastRunAt) : '—'}{' '}
                  {r.runUrl && <a className="mon-xlink" href={r.runUrl} target="_blank" rel="noreferrer">run ↗</a>}
                </span>
                <span className="muted">{r.failingSince ? `${r.failingSinceExact ? '' : 'before '}${ago(r.failingSince)}` : ''}</span>
                <span className="mono" title="oldest → newest: ✓ passed, ✗ failed">{(r.trend ?? []).map((p) => (p.passed ? '✓' : '✗')).join(' ') || '—'}</span>
              </div>
            ))}
          </div>
          <p className="hint">Failing rows are the count dbt reported for the failing test; “—” means dbt reported none (the OS does not count rows).</p>
        </>
      )}
    </>
  );
}

function DataPanels({ v }: { v: DataView }) {
  const sorted = [...v.datasets].sort((a, b) => score(b) - score(a));
  return (
    <div className="mon-panels">
      <div className="mon-sub">Datasets <span className="mon-sub-note">Dagster runs · asset checks (dbt tests) · Dagster lineage</span></div>
      <Sources sources={v.sources} />
      {v.laneAlerts.map((a) => (
        <div key={a.runId} className="mon-tr err" role="alert">
          <span>Alert: a hand-launched run selected a model outside its owner&apos;s lane{a.models.length ? `: ${a.models.join(', ')}` : ''}{a.hidden ? ` (+${a.hidden} not visible to you)` : ''}
            {a.url ? <> <a className="mon-xlink" href={a.url} target="_blank" rel="noreferrer">run ↗</a></> : null}</span>
        </div>
      ))}
      <RuleQuality v={v} />
      <div className="mon-sub">Datasets</div>
      {sorted.length === 0 ? <p className="hint">No datasets in your scope.</p> : <div className="mon-tile-grid">{sorted.map((d) => <DatasetCard key={d.id} d={d} v={v} />)}</div>}
      <NotOffered items={v.notUpstream} />
    </div>
  );
}

/** Attention first: failing jobs and tests before healthy datasets. */
function score(d: DatasetPanel): number {
  return (d.jobs ?? []).filter((j) => j.lastStatus === 'FAILURE').length * 10 + (d.tests?.failing.length ?? 0) * 5 + (d.lastSuccessAt === null ? 1 : 0);
}

function PlatformPanels({ v }: { v: PlatformView }) {
  const down = v.components.filter((c) => c.status !== 'ready');
  return (
    <div className="mon-panels">
      <div className="mon-sub">Components <span className="mon-sub-note">each component&apos;s own health endpoint</span></div>
      <div className="mon-dq-row">
        {v.components.map((c) => (
          <span key={c.id} className={`badge${c.status === 'ready' ? ' ok' : c.status === 'degraded' ? ' warn' : ' err'}`} title={c.detail}>
            {c.id}{c.version ? ` ${c.version}` : ''} · {c.status}
          </span>
        ))}
      </div>
      {down.length > 0 && <p className="hint" style={{ marginTop: 0 }}>{down.map((c) => `${c.id}: ${c.detail}`).join(' · ')}</p>}
      {v.repoGate.missing.length > 0 && (
        <div className="mon-tr err" role="alert">
          <span>Data repositories without the OS&apos;s list of generated files: {v.repoGate.missing.join(', ')}. Builders cannot push models or tests there until it is written. Reconcile a domain: POST /api/platform-admin/data-projects/&lt;domain&gt;/reconcile.</span>
        </div>
      )}

      <div className="mon-sub">Resource pressure <span className="mon-sub-note">VictoriaMetrics · kubelet_stats</span></div>
      <Sources sources={{ victoriaMetrics: v.pressure.state }} />
      {v.pressure.nodes.length > 0 && (
        <div className="mon-stats">
          {v.pressure.nodes.map((n) => (
            <Stat key={n.node} label={`${n.node} · mem / disk`} value={`${pct(n.memory)} / ${pct(n.disk)}`} tone={(n.memory ?? 0) > 0.9 || (n.disk ?? 0) > 0.85 ? 'error' : (n.memory ?? 0) > 0.8 ? 'warn' : undefined} />
          ))}
        </div>
      )}
      {(v.pressure.topMemory.length > 0 || v.pressure.topCpu.length > 0) && (
        <div className="mon-table" style={{ marginTop: 8 }}>
          <div className="mon-tr mon-th mon-tr-pjob"><span>Pod (top memory)</span><span>Namespace</span><span>Working set</span><span /></div>
          {v.pressure.topMemory.map((p) => (
            <div key={`m-${p.namespace}-${p.pod}`} className="mon-tr mon-tr-pjob"><span className="mono ellip">{p.pod}</span><span className="muted ellip">{p.namespace}</span><span>{bytes(p.value)}</span><span /></div>
          ))}
          <div className="mon-tr mon-th mon-tr-pjob"><span>Pod (top CPU)</span><span>Namespace</span><span>Cores</span><span /></div>
          {v.pressure.topCpu.map((p) => (
            <div key={`c-${p.namespace}-${p.pod}`} className="mon-tr mon-tr-pjob"><span className="mono ellip">{p.pod}</span><span className="muted ellip">{p.namespace}</span><span>{p.value.toFixed(2)}</span><span /></div>
          ))}
        </div>
      )}

      <div className="mon-sub">Error logs, last hour <span className="mon-sub-note">VictoriaLogs · lines containing &quot;error&quot;</span></div>
      <Sources sources={{ victoriaLogs: v.errorLogs.state }} />
      {v.errorLogs.state.state === 'live' && v.errorLogs.rows.length === 0 && <p className="hint">No log line containing &quot;error&quot; in the last hour.</p>}
      {v.errorLogs.rows.length > 0 && (
        <div className="mon-table">
          {v.errorLogs.rows.map((r) => (
            <div key={`${r.namespace}-${r.container}`} className="mon-tr mon-tr-pjob"><span className="mono ellip">{r.container}</span><span className="muted ellip">{r.namespace}</span><span>{r.errors}</span><span /></div>
          ))}
        </div>
      )}

      <div className="mon-sub">Backups</div>
      <Sources sources={{ backups: v.backups.state }} />
      {v.backups.state.state === 'live' && v.backups.items.length === 0 ? <p className="hint">No backup signal readable.</p> : v.backups.items.length > 0 && (
        <div className="mon-table">
          {v.backups.items.map((b) => (
            <div key={b.id} className={`mon-tr mon-tr-pfail${b.health === 'red' ? ' err' : ''}`}><span>{b.health}</span><span className="ellip" title={b.detail}>{b.title} — {b.detail}</span><span className="muted">{b.ts ? ago(b.ts) : ''}</span></div>
          ))}
        </div>
      )}

      <div className="mon-sub">Alerts firing now</div>
      <Sources sources={{ alerts: v.alerts.state }} />
      {v.alerts.state.state === 'live' && v.alerts.items.length === 0 ? <p className="hint">No operational alert is firing.</p> : v.alerts.items.length > 0 && (
        <div className="mon-table">
          {v.alerts.items.map((a) => (
            <div key={a.id} className={`mon-tr mon-tr-pfail${a.severity === 'critical' ? ' err' : ''}`}><span>{a.severity}</span><span className="ellip" title={a.detail}>{a.title} — {a.detail}</span><span className="muted">{a.disposition}</span></div>
          ))}
        </div>
      )}
      <NotOffered items={v.notUpstream} />
    </div>
  );
}

const FILE_CONV: Record<FilePanel['conversion'], string> = { extracted: 'converted', pending: 'converting', failed: 'conversion failed', not_needed: 'no conversion needed' };
const FILE_IDX: Record<FilePanel['indexing'], string> = { indexed: 'searchable', empty: 'nothing to index', failed: 'indexing failed', stored_only: 'stored only', not_indexed: 'not indexed' };

const DRIVE_STATE: Record<DrivePanel['state'], string> = { ok: 'syncing', failed: 'last sync failed', lagging: 'behind', paused: 'paused', needs_reconnect: 'needs reconnect', never_synced: 'not synced yet' };

function DrivePanels({ d }: { d: FilesView['drives'] }) {
  const sm = d.summary;
  return (
    <>
      <div className="mon-sub">Connected drives <span className="mon-sub-note">sync runs as the OS recorded them · schedule from Dagster</span></div>
      <Sources sources={d.sources} />
      {d.schedule && (
        <p className="hint">Schedule {d.schedule.name}: {d.schedule.status === 'RUNNING' ? `${d.schedule.cron}, next ${d.schedule.nextTickAt ?? 'unknown'}` : 'stopped'}{d.lastDagsterRun ? ` · Dagster's last run ${d.lastDagsterRun.status}${d.lastDagsterRun.endedAt ? `, ${ago(d.lastDagsterRun.endedAt)}` : ''}` : ' · Dagster has no run of it yet'}</p>
      )}
      {sm && (
        <div className="mon-stats">
          <Stat label="drives" value={String(sm.connections)} />
          <Stat label="last sync failed" value={String(sm.failing)} tone={sm.failing ? 'error' : undefined} />
          <Stat label="behind" value={String(sm.lagging)} tone={sm.lagging ? 'warn' : undefined} />
          <Stat label="paused" value={String(sm.paused)} tone={sm.paused ? 'warn' : undefined} />
          <Stat label="need reconnect" value={String(sm.needsReconnect)} tone={sm.needsReconnect ? 'error' : undefined} />
        </div>
      )}
      {d.connections.length === 0 ? (
        <p className="hint">{d.sources.drives.state === 'live' ? 'No connected drives in your scope.' : 'Connected drives could not be listed.'}</p>
      ) : (
        <div className="mon-table">
          <div className="mon-tr mon-th mon-tr-pfile"><span>Drive</span><span>Last sync</span><span>Imported · lag</span><span>State</span></div>
          {d.connections.map((c) => (
            <div key={c.id} className={`mon-tr mon-tr-pfile${c.state === 'failed' || c.state === 'needs_reconnect' ? ' err' : ''}`}>
              <span className="ellip" title={c.label}><a className="mon-xlink" href={c.connectionsUrl}>{c.label}</a> <span className="muted">· {c.domain || 'personal'} · {c.provider}</span></span>
              <span title={c.lastSync?.error ?? ''}>{c.lastSync ? `${ago(c.lastSync.at)} · ${c.lastSync.trigger} · ${c.lastSync.ok ? `+${c.lastSync.added} new, ${c.lastSync.changed} changed, ${c.lastSync.unchanged} unchanged, ${Math.round(c.lastSync.durationMs / 1000)}s` : `failed: ${c.lastSync.error ?? 'no error text'}`}` : 'never'}</span>
              <span>{c.filesImported} files · {c.lagMinutes === null ? 'no successful sync' : `${c.lagMinutes} min`}</span>
              <span title={c.paused?.reason ?? ''}>{DRIVE_STATE[c.state]}{c.paused ? ` — ${c.paused.reason}` : ''}{c.failedRuns ? ` · ${c.failedRuns} of last ${c.historyRuns} runs failed` : ''}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function FilesPanels({ v }: { v: FilesView }) {
  const sm = v.summary;
  return (
    <div className="mon-panels">
      <div className="mon-sub">Files <span className="mon-sub-note">Docling conversion (as recorded) · OpenSearch index rows</span></div>
      <Sources sources={v.sources} />
      <DrivePanels d={v.drives} />
      {sm && (
        <div className="mon-stats">
          <Stat label="files" value={String(sm.total)} />
          <Stat label="searchable" value={String(sm.searchable)} />
          <Stat label="conversion failed" value={String(sm.conversionFailed)} tone={sm.conversionFailed ? 'error' : undefined} />
          <Stat label="indexing failed" value={String(sm.indexingFailed)} tone={sm.indexingFailed ? 'error' : undefined} />
          <Stat label="converting" value={String(sm.converting)} tone={sm.converting ? 'warn' : undefined} />
          <Stat label="OS and OpenSearch disagree" value={v.sources.openSearch.state === 'live' ? String(sm.disagreements) : '—'} tone={sm.disagreements ? 'warn' : undefined} />
        </div>
      )}
      {Object.keys(v.conversionFailuresByCode).length > 0 && (
        <p className="hint">Conversion failures: {Object.entries(v.conversionFailuresByCode).map(([c, n]) => `${c} ×${n}`).join(' · ')}</p>
      )}
      {v.files.length === 0 ? (
        <p className="hint">{v.sources.inventory.state === 'live' ? 'No files in your scope.' : 'Files could not be listed.'}</p>
      ) : (
        <div className="mon-table">
          <div className="mon-tr mon-th mon-tr-pfile"><span>File</span><span>Conversion</span><span>Indexing</span><span>Rows in OpenSearch</span></div>
          {v.files.map((f) => (
            <div key={f.id} className={`mon-tr mon-tr-pfile${f.conversion === 'failed' || f.indexing === 'failed' ? ' err' : ''}`}>
              <span className="ellip" title={f.name}><a className="mon-xlink" href={f.filesUrl}>{f.name}</a> <span className="muted">· {f.domain || 'personal'}</span></span>
              <span title={f.conversionFailure?.reason ?? ''}>{FILE_CONV[f.conversion]}{f.conversionFailure?.code ? ` — ${f.conversionFailure.code}` : ''}</span>
              <span title={f.indexingFailure?.reason ?? ''}>{FILE_IDX[f.indexing]}</span>
              <span>{f.openSearchRows === undefined ? '—' : f.openSearchRows}{f.agreement === 'missing_in_index' ? ' · recorded indexed, none found' : f.agreement === 'unrecorded_rows' ? ' · rows without a recorded index run' : ''}</span>
            </div>
          ))}
        </div>
      )}
      {v.truncated && <p className="hint">Showing the files needing attention first; the counts above cover every file in your scope.</p>}
      <NotOffered items={v.notUpstream} />
    </div>
  );
}

const KN_STATE: Record<NonNullable<KnowledgeView['workflows'][number]['index']>['state'], string> = { indexed: 'indexed', stale: 'stale — edited after the last index', not_indexed: 'published but not indexed', draft_not_indexed: 'draft (not indexed)' };

function KnowledgePanels({ v }: { v: KnowledgeView }) {
  const sm = v.summary;
  return (
    <div className="mon-panels">
      <div className="mon-sub">Knowledge <span className="mon-sub-note">OpenSearch rows and ingest time per workflow</span></div>
      <Sources sources={v.sources} />
      {sm && (
        <div className="mon-stats">
          <Stat label="workflows" value={String(sm.total)} />
          <Stat label="indexed" value={String(sm.indexed)} />
          <Stat label="stale" value={String(sm.stale)} tone={sm.stale ? 'warn' : undefined} />
          <Stat label="published, not indexed" value={String(sm.notIndexed)} tone={sm.notIndexed ? 'error' : undefined} />
          {v.searchLatency !== undefined && <Stat label="avg search (index-wide)" value={v.searchLatency.avgMs !== null ? ms(v.searchLatency.avgMs) : '—'} />}
          {v.searchLatencyUnavailable && <Stat label="avg search (index-wide)" value="unavailable" tone="warn" />}
        </div>
      )}
      {v.workflows.length === 0 ? (
        <p className="hint">{v.sources.inventory.state === 'live' ? 'No knowledge workflows in your scope.' : 'Knowledge could not be listed.'}</p>
      ) : (
        <div className="mon-table">
          <div className="mon-tr mon-th mon-tr-pfile"><span>Workflow</span><span>Index</span><span>Rows</span><span>Last indexed</span></div>
          {v.workflows.map((w) => (
            <div key={w.id} className={`mon-tr mon-tr-pfile${w.index?.state === 'not_indexed' ? ' err' : ''}`}>
              <span className="ellip" title={w.title}><a className="mon-xlink" href={w.knowledgeUrl}>{w.title}</a> <span className="muted">· {w.domain || 'personal'} · {w.status}</span></span>
              <span>{w.index ? KN_STATE[w.index.state] : '—'}</span>
              <span>{w.index ? w.index.rows : '—'}</span>
              <span className="muted">{w.index?.lastIndexedAt ? ago(w.index.lastIndexedAt) : '—'}</span>
            </div>
          ))}
        </div>
      )}
      <NotOffered items={v.notUpstream} />
    </div>
  );
}

function KpisPanels({ v }: { v: KpisView }) {
  const sm = v.summary;
  return (
    <div className="mon-panels">
      <div className="mon-sub">KPIs <span className="mon-sub-note">metric registry · Dagster runs · stored alert rules</span></div>
      <Sources sources={v.sources} />
      {sm && (
        <div className="mon-stats">
          <Stat label="metrics" value={String(sm.metrics)} />
          <Stat label="cannot be read" value={String(sm.loadErrors)} tone={sm.loadErrors ? 'error' : undefined} />
          <Stat label="alerts firing" value={String(sm.alertsFiring)} tone={sm.alertsFiring ? 'error' : undefined} />
          <Stat label="alert evaluation failed (last run)" value={v.sources.dagster.state === 'live' ? String(sm.alertsFailing) : '—'} tone={sm.alertsFailing ? 'warn' : undefined} />
        </div>
      )}
      <div className="mon-sub">Alerts</div>
      {v.alerts.length === 0 ? <p className="hint">{v.sources.alerts.state === 'live' ? 'No alert rules in your scope.' : 'Alert rules could not be read.'}</p> : (
        <div className="mon-table">
          <div className="mon-tr mon-th mon-tr-pfile"><span>Rule</span><span>State</span><span>Last value</span><span>Evaluations (Dagster)</span></div>
          {v.alerts.map((a) => (
            <div key={a.id} className={`mon-tr mon-tr-pfile${a.firing ? ' err' : ''}`}>
              <span className="ellip" title={a.member}><span className="mono">{a.member}</span> {a.condition} <span className="muted">· {a.domain}</span></span>
              <span><span className={`badge${a.firing ? ' err' : a.lastEvaluated ? ' ok' : ' muted'}`}>{a.firing ? 'firing' : a.lastEvaluated ? 'ok' : 'never evaluated'}</span>{a.lastEvaluated ? <span className="muted"> {ago(a.lastEvaluated)}</span> : null}</span>
              <span>{a.lastValue === undefined ? '—' : String(a.lastValue)}</span>
              <span>{a.evaluations === undefined ? '—' : a.evaluations.runs === 0 ? 'no run in the window' : `${a.evaluations.failures} failed / ${a.evaluations.runs}`}{a.evaluations?.lastFailureUrl ? <> <a className="mon-xlink" href={a.evaluations.lastFailureUrl} target="_blank" rel="noreferrer">run ↗</a></> : null}</span>
            </div>
          ))}
        </div>
      )}
      <div className="mon-sub">Metrics</div>
      {v.metrics.length === 0 ? <p className="hint">{v.sources.inventory.state === 'live' ? 'No metrics in your scope.' : 'Metrics could not be listed.'}</p> : (
        <div className="mon-table">
          <div className="mon-tr mon-th mon-tr-pfile"><span>Metric</span><span>Dataset data last built</span><span>Alerts firing</span><span>Status</span></div>
          {v.metrics.map((m) => (
            <div key={m.id} className={`mon-tr mon-tr-pfile${m.loadError ? ' err' : ''}`}>
              <span className="ellip" title={m.name}><a className="mon-xlink" href={m.kpisUrl}>{m.name}</a> <span className="muted">· {m.datasetName}</span></span>
              <span className="muted">{m.dataLastSuccessAt === undefined ? '—' : m.dataLastSuccessAt ? ago(m.dataLastSuccessAt) : 'no successful run in the window'}</span>
              <span>{m.alertsFiring}</span>
              <span title={m.loadError ?? ''}>{m.loadError ? `cannot be read — ${m.loadError}` : 'readable'}</span>
            </div>
          ))}
        </div>
      )}
      <NotOffered items={v.notUpstream} />
    </div>
  );
}

function DashboardsPanels({ v }: { v: DashboardsView }) {
  const sm = v.summary;
  return (
    <div className="mon-panels">
      <div className="mon-sub">Dashboards <span className="mon-sub-note">each panel’s members checked against the served model</span></div>
      <Sources sources={v.sources} />
      {sm && (
        <div className="mon-stats">
          <Stat label="dashboards" value={String(sm.dashboards)} />
          <Stat label="with broken references" value={String(sm.withBrokenReferences)} tone={sm.withBrokenReferences ? 'error' : undefined} />
          <Stat label="broken panels" value={String(sm.brokenPanels)} tone={sm.brokenPanels ? 'error' : undefined} />
        </div>
      )}
      {v.dashboards.length === 0 ? <p className="hint">{v.sources.inventory.state === 'live' ? 'No dashboards in your scope.' : 'Dashboards could not be listed.'}</p> : (
        <div className="mon-table">
          <div className="mon-tr mon-th mon-tr-pfile"><span>Dashboard</span><span>View</span><span>Panels</span><span>Broken references</span></div>
          {v.dashboards.map((d) => (
            <div key={d.id} className={`mon-tr mon-tr-pfile${d.broken.length || !d.viewServed ? ' err' : ''}`}>
              <span className="ellip" title={d.name}><a className="mon-xlink" href={d.dashboardsUrl}>{d.name}</a> <span className="muted">· {d.domain || 'personal'}</span></span>
              <span className="mono ellip">{d.view}{d.viewServed ? '' : ' — not served'}</span>
              <span>{d.panels}</span>
              <span>{d.broken.length === 0 ? (d.viewServed ? 'none' : 'view not served') : d.broken.map((b) => `${b.panel}: ${b.missing.join(', ')}`).join(' · ')}</span>
            </div>
          ))}
        </div>
      )}
      <NotOffered items={v.notUpstream} />
    </div>
  );
}

export default function PanelsView({ kind }: { kind: PanelKind }) {
  const { data, loading, error } = useApi<AgentsView | DataView | PlatformView | FilesView | KnowledgeView | KpisView | DashboardsView>(`/api/monitoring/panels?view=${kind}`);
  if (error) return <div className="error" style={{ marginTop: 12 }}>{error}</div>;
  if (!data) return loading ? <div className="hint" style={{ marginTop: 12 }}><span className="spin" /> Reading the components…</div> : null;
  if (data.view === 'agents') return <AgentsPanels v={data} />;
  if (data.view === 'data') return <DataPanels v={data} />;
  if (data.view === 'files') return <FilesPanels v={data} />;
  if (data.view === 'knowledge') return <KnowledgePanels v={data} />;
  if (data.view === 'kpis') return <KpisPanels v={data} />;
  if (data.view === 'dashboards') return <DashboardsPanels v={data} />;
  return <PlatformPanels v={data} />;
}
