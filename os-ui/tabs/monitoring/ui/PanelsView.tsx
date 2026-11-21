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

import { useApi } from '@core/ui/useApi';
import type { AgentsView, AgentSystemPanel } from '@tabs/monitoring/lib/panels/agents-panel';
import type { DataView, DatasetPanel } from '@tabs/monitoring/lib/panels/data-panel';
import type { PlatformView } from '@tabs/monitoring/lib/panels/platform-panel';
import type { NotUpstream, SourceState } from '@tabs/monitoring/lib/panels/panels-core';
import { ago, compact, usd } from '@tabs/monitoring/ui/format';

export type PanelKind = 'agents' | 'data' | 'platform';

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
        <Stat label="tests failing" value={d.tests ? `${d.tests.failing.length} / ${d.tests.total}` : '—'} tone={d.tests?.failing.length ? 'error' : undefined} />
        <Stat label="quality (last run)" value={last ? `${last.passed}/${last.total}` : '—'} />
      </div>
      {d.trend && d.trend.length > 1 && (
        <p className="hint" style={{ margin: '2px 0 6px' }}>Trend (checks passed per run): {d.trend.map((p) => `${p.passed}/${p.total}`).join(' → ')}</p>
      )}
      {d.tests && d.tests.failing.length > 0 && (
        <p className="hint" style={{ margin: '2px 0 6px' }}>
          Failing: {d.tests.failing.map((f) => `${f.name}${f.violations !== null ? ` (${f.violations} rows)` : ''}`).join(' · ')}
          {d.tests.source === 'os' ? ' — OS probe, no dbt test has run yet' : ''}
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
          ({Object.entries(d.downstreamHidden.byDomain).map(([dom, n]) => `${dom} ${n}`).join(' · ')})
        </p>
      )}
      {v.sources.dagsterRuns.state === 'live' && (d.jobs?.length ?? 0) === 0 && <p className="hint" style={{ margin: '6px 0 0' }}>No Dagster runs for this dataset in the recent run window.</p>}
    </div>
  );
}

function DataPanels({ v }: { v: DataView }) {
  const sorted = [...v.datasets].sort((a, b) => score(b) - score(a));
  return (
    <div className="mon-panels">
      <div className="mon-sub">Datasets <span className="mon-sub-note">Dagster runs · asset checks (dbt tests) · Dagster lineage</span></div>
      <Sources sources={v.sources} />
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

export default function PanelsView({ kind }: { kind: PanelKind }) {
  const { data, loading, error } = useApi<AgentsView | DataView | PlatformView>(`/api/monitoring/panels?view=${kind}`);
  if (error) return <div className="error" style={{ marginTop: 12 }}>{error}</div>;
  if (!data) return loading ? <div className="hint" style={{ marginTop: 12 }}><span className="spin" /> Reading the components…</div> : null;
  if (data.view === 'agents') return <AgentsPanels v={data} />;
  if (data.view === 'data') return <DataPanels v={data} />;
  return <PlatformPanels v={data} />;
}
