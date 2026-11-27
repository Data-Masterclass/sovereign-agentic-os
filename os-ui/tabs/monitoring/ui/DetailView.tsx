/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Monitoring diagnosis view — full-page detail for one agent system or dataset
 * USER STORY: As a user who opened an agent or dataset tile I want its telemetry, profile,
 *             last run, history, tool calls and data-quality detail on one page so that I can
 *             diagnose it without leaving Monitoring.
 * ARCHITECTURE:
 *   - Client component rendered by `app/(govern)/monitoring/page.tsx`; replaces the tile grid
 *     and returns via `onBack`. Read-only.
 *   - Fetches `/api/monitoring/agent/{id}` or `/api/monitoring/dataset/{id}` on mount; 403 and
 *     404 are shown as plain messages.
 *   - Agent sections: 7-day telemetry, system profile, last-run report, run history (Langfuse +
 *     in-process ring), governed tool calls, errors. Dataset sections: DQ, medallion build,
 *     lineage. (Data versions are the table's Iceberg snapshots, shown in the Data tab.)
 *   - i18n: labels, headers and status words render through the `monitoring` catalog (status words via
 *     `status-labels.ts`), numbers/times/money through `format.ts` with the active locale. Server-written text
 *     (profile description/trigger/runtime, node errors and summaries, issue details, the DQ source label, check
 *     reasons, API error text) is shown verbatim, in English, until wave 4.
 */
'use client';

import { useEffect, useState } from 'react';
import { useTranslations, useFormat, useServerMessage } from '@core/i18n/client';
import { ago, compact, count, dur, money } from '@tabs/monitoring/ui/format';
import { statusKey } from '@tabs/monitoring/ui/status-labels';

type Health7 = 'ok' | 'warn' | 'error';

type GrantGroup = { kind: string; count: number; rows: { id: string; name: string; capability: string }[] };
type SystemProfile = {
  runtime: string; safetyPreset: string; trigger: string; description?: string;
  nodes: { id: string; role: string; model: string; supervisor: boolean; entry: boolean; disabled: boolean }[];
  tools: string[];
  grants: GrantGroup[];
};
type LastRunReport = {
  at: number; ok: boolean; running: boolean; trigger: string; path: string[]; held: number; output?: string;
  nodes: {
    node: string; model?: string; tier?: string; tierReason?: string; status: string; error?: string;
    input?: string; finalText?: string; steps: { tool: string; isError: boolean; summary?: string }[];
  }[];
};
type ToolTraceRow = { at: number; tool: string; node?: string; decision: string; landed: boolean; detail?: string };

type AgentDetail = {
  id: string; name: string; domain: string; agentCount: number;
  running: boolean; scheduled: boolean;
  telemetry: { costUsd: number; tokens: number; runs: number; lastRunAt: number | null; warnings: number; errors: number; overall: Health7 };
  costSeries: { day: number; value: number }[];
  tokenSeries: { day: number; value: number }[];
  runs: { id: string; at: number; name: string; model?: string; decision?: string; health: Health7; costUsd?: number; tokens?: number; ms?: number; source: string; traceUrl?: string }[];
  issues: { at: number; name: string; health: 'warn' | 'error'; detail: string }[];
  profile: SystemProfile | null;
  lastRun: LastRunReport | null;
  toolTrace: ToolTraceRow[];
  source: string; langfuseReachable: boolean;
  links: { agent: string; langfuse: string };
};

type DqCheck = { id: string; label: string; verdict: 'pass' | 'fail' | 'not_run'; violations: number | null; reason?: string };
type DatasetDetail = {
  id: string; name: string; domain: string; tier: string;
  freshness: string | null; ageDays: number | null;
  telemetry: { checksPassing: number; checksFailing: number; checksNotRun: number; checksWarning?: number; warnings: number; errors: number; overall: Health7 };
  dq: {
    summary: { rules: number; passing: number; violated: number; notRun: number; hasRun: boolean; violatedRules: { id: string; label: string; violations: number | null }[] };
    ranAt: string | null; score: number | null;
    trend: { ranAt: string; score: number | null; badge: string }[];
    checks: DqCheck[];
    /** Who produced the verdict — rendered as a small attribution badge (review B2-review-M5).
     *  The wording is decided in `detail-view.ts` (a tab's UI may not import another tab). */
    sourceLabel?: { text: string; title: string } | null;
  };
  layers: { layer: string; built: boolean; passThrough: boolean; quality: string; updatedAt: string | null }[];
  lineage: { nodes: { id: string; kind: string; label: string; sublabel: string; built: boolean }[]; edges: { from: string; to: string; kind: string }[] };
  links: { data: string };
};

export type DetailTarget = { kind: 'agent' | 'dataset'; id: string; name?: string };

const H7_DOT: Record<Health7, string> = { ok: 'h-green', warn: 'h-amber', error: 'h-red' };
const DECISION_DOT: Record<string, string> = { allow: 'h-green', deny: 'h-red', requires_approval: 'h-amber' };

/** The tab's translator, the active locale, and `st(raw)` — a known status word in the user's language, else verbatim. */
function useLabels() {
  const t = useTranslations('monitoring');
  const { locale } = useFormat();
  const st = (raw: string | null | undefined): string => {
    const k = statusKey(raw);
    return k ? t(`status.${k}`) : String(raw ?? '');
  };
  return { t, locale, st };
}

/** A tiny SVG sparkline (no library) for a per-day series. */
function Spark({ data, color }: { data: { day: number; value: number }[]; color: string }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  const w = 220, h = 40, n = data.length;
  const pts = data.map((d, i) => {
    const x = n === 1 ? 0 : (i / (n - 1)) * w;
    const y = h - (d.value / max) * (h - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="mon-detail-spark">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.6" />
    </svg>
  );
}

function Stat({ label, value, tone }: { label: string; value: React.ReactNode; tone?: 'warn' | 'error' }) {
  return (
    <div className={`mon-stat${tone ? ` ${tone}` : ''}`}>
      <div className="mon-stat-v">{value}</div>
      <div className="mon-stat-l">{label}</div>
    </div>
  );
}

export default function DetailView({ target, onBack }: { target: DetailTarget; onBack: () => void }) {
  const t = useTranslations('monitoring');
  const msg = useServerMessage();
  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [dataset, setDataset] = useState<DatasetDetail | null>(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setLoading(true); setErr(''); setAgent(null); setDataset(null);
    const url = target.kind === 'agent'
      ? `/api/monitoring/agent/${encodeURIComponent(target.id)}`
      : `/api/monitoring/dataset/${encodeURIComponent(target.id)}`;
    fetch(url, { cache: 'no-store' })
      .then(async (res) => {
        const body = await res.json();
        if (!live) return;
        if (!res.ok) {
          setErr(res.status === 403 ? t('detail.outOfScope') : res.status === 404 ? t('detail.notFound') : msg(body, t('detail.failed', { status: res.status })));
        } else if (target.kind === 'agent') setAgent(body.detail as AgentDetail);
        else setDataset(body.detail as DatasetDetail);
      })
      .catch((e) => { if (live) setErr((e as Error).message); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `t` is stable per locale; refetching on it is not wanted
  }, [target.id, target.kind]);

  return (
    <>
      <div className="row" style={{ alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <button className="btn ghost" onClick={onBack}>{t('detail.back')}</button>
        <span className="crumb">{target.kind === 'agent' ? t('detail.agentCrumb') : t('detail.datasetCrumb')}</span>
      </div>
      {loading && <div style={{ marginTop: 8 }}><span className="spin" /> <span className="muted">{t('detail.loading')}</span></div>}
      {err && <div className="error" style={{ marginTop: 8 }}>{err}</div>}
      {agent && <AgentBody a={agent} />}
      {dataset && <DatasetBody d={dataset} />}
    </>
  );
}

// ------------------------------------------------------------------- agent --

function ProfileSection({ p }: { p: SystemProfile | null }) {
  const { t, locale } = useLabels();
  if (!p) {
    return (
      <>
        <div className="mon-sub">{t('detail.profile.title')}</div>
        <p className="hint" style={{ marginTop: 0 }}>{t('detail.profile.unavailable')}</p>
      </>
    );
  }
  const granted = p.grants.filter((g) => g.count > 0);
  return (
    <>
      <div className="mon-sub">{t('detail.profile.title')}</div>
      {p.description && <p className="hint" style={{ marginTop: 0, marginBottom: 8 }}>{p.description}</p>}
      <div className="mon-dq-row">
        <span className="badge muted">{t('detail.profile.runtime', { runtime: p.runtime })}</span>
        <span className="badge muted">{t('detail.profile.safety', { preset: p.safetyPreset })}</span>
        <span className="badge">{p.trigger}</span>
        {p.tools.length > 0 && <span className="badge muted">{t('detail.profile.tools', { count: p.tools.length, list: p.tools.join(', ') })}</span>}
      </div>
      <div className="mon-table">
        <div className="mon-tr mon-th mon-tr-node"><span>{t('detail.profile.colAgent')}</span><span>{t('detail.profile.colRole')}</span><span>{t('detail.profile.colModel')}</span><span /></div>
        {p.nodes.map((n) => (
          <div key={n.id} className="mon-tr mon-tr-node">
            <span className="mono ellip">{n.id}</span>
            <span className="ellip">{n.role}</span>
            <span className="muted ellip">{n.model}</span>
            <span>
              {n.entry && <span className="badge muted">{t('detail.profile.entry')}</span>}{' '}
              {n.supervisor && <span className="badge muted">{t('detail.profile.supervisor')}</span>}{' '}
              {n.disabled && <span className="badge err">{t('detail.profile.off')}</span>}
            </span>
          </div>
        ))}
      </div>
      {granted.length === 0 ? (
        <p className="hint" style={{ marginTop: 8 }}>{t('detail.profile.noGrants')}</p>
      ) : (
        granted.map((g) => (
          <div key={g.kind} className="mon-dq-row" style={{ marginTop: 8, marginBottom: 0 }}>
            <span className="badge muted">{g.kind} · {count(g.count, locale)}</span>
            {g.rows.slice(0, 6).map((r) => (
              <span key={r.id + r.name} className="badge" title={r.capability}>{r.name}</span>
            ))}
            {g.count > 6 && <span className="muted" style={{ fontSize: 12 }}>{t('detail.profile.more', { count: count(g.count - 6, locale) })}</span>}
          </div>
        ))
      )}
    </>
  );
}

function LastRunSection({ r }: { r: LastRunReport | null }) {
  const { t, locale, st } = useLabels();
  return (
    <>
      <div className="mon-sub">
        {t('detail.lastRun.title')}{r ? <span className="mon-sub-note">{t('detail.lastRun.note', { ago: ago(r.at, locale) })}</span> : null}
      </div>
      {!r ? (
        <p className="hint" style={{ marginTop: 0 }}>{t('detail.lastRun.empty')}</p>
      ) : (
        <>
          <div className="mon-dq-row">
            {r.running
              ? <span className="badge">{t('detail.lastRun.running')}</span>
              : <span className={`badge ${r.ok ? 'ok' : 'err'}`}>{r.ok ? t('detail.lastRun.succeeded') : t('detail.lastRun.failed')}</span>}
            <span className="badge muted">{st(r.trigger)}</span>
            {r.path.length > 0 && <span className="badge muted mono">{r.path.join(' → ')}</span>}
            {r.held > 0 && <span className="badge">{t('detail.lastRun.held', { count: count(r.held, locale) })}</span>}
          </div>
          {r.nodes.length > 0 && (
            <div className="mon-nodes">
              {r.nodes.map((n) => (
                <details key={n.node} className="mon-node">
                  <summary>
                    <span className={`mon-dot ${n.status === 'error' ? 'h-red' : n.error ? 'h-amber' : 'h-green'}`} />
                    <span className="mono">{n.node}</span>
                    <span className="muted ellip" style={{ flex: 1 }}>
                      {n.model ?? ''}{n.tier ? ` · ${n.tier}` : ''}
                    </span>
                    <span className="muted">{t('detail.lastRun.steps', { count: n.steps.length, status: st(n.status) })}</span>
                  </summary>
                  <div className="mon-node-body">
                    {n.tierReason && <p className="hint" style={{ marginTop: 0 }}>{t('detail.lastRun.routing', { reason: n.tierReason })}</p>}
                    {n.error && <div className="error" style={{ marginBottom: 8 }}>{n.error}</div>}
                    {n.input && <div className="mon-logs" style={{ marginBottom: 8 }}>{t('detail.lastRun.input', { text: n.input })}</div>}
                    {n.steps.length > 0 && (
                      <div className="mon-table">
                        <div className="mon-tr mon-th mon-tr-step"><span>{t('detail.lastRun.colTool')}</span><span>{t('detail.lastRun.colStatus')}</span><span>{t('detail.lastRun.colSummary')}</span></div>
                        {n.steps.map((s, i) => (
                          <div key={i} className={`mon-tr mon-tr-step${s.isError ? ' err' : ''}`}>
                            <span className="mono ellip">{s.tool}</span>
                            <span><span className={`mon-dot ${s.isError ? 'h-red' : 'h-green'}`} /> {s.isError ? st('error') : st('ok')}</span>
                            <span className="ellip">{s.summary ?? '—'}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {n.finalText && <div className="mon-logs" style={{ marginTop: 8 }}>{t('detail.lastRun.output', { text: n.finalText })}</div>}
                  </div>
                </details>
              ))}
            </div>
          )}
          {r.output && <div className="mon-logs" style={{ marginTop: 8 }}>{r.output}</div>}
        </>
      )}
    </>
  );
}

function ToolTraceSection({ rows }: { rows: ToolTraceRow[] }) {
  const { t: tr, locale, st } = useLabels();
  return (
    <>
      <div className="mon-sub">{tr('detail.trace.title')} <span className="mon-sub-note">{tr('detail.trace.note')}</span></div>
      {rows.length === 0 ? (
        <p className="hint" style={{ marginTop: 0 }}>{tr('detail.trace.empty')}</p>
      ) : (
        <div className="mon-table">
          <div className="mon-tr mon-th mon-tr-trace"><span>{tr('detail.trace.colTime')}</span><span>{tr('detail.trace.colTool')}</span><span>{tr('detail.trace.colAgent')}</span><span>{tr('detail.trace.colDecision')}</span><span>{tr('detail.trace.colDetail')}</span></div>
          {rows.map((t, i) => (
            <div key={i} className={`mon-tr mon-tr-trace${t.decision === 'deny' ? ' err' : ''}`}>
              <span className="muted">{ago(t.at, locale)}</span>
              <span className="mono ellip">{t.tool}</span>
              <span className="mono ellip">{t.node ?? '—'}</span>
              <span><span className={`mon-dot ${DECISION_DOT[t.decision] ?? 'h-unknown'}`} /> {st(t.decision)}</span>
              <span className="ellip">{t.detail ?? (t.landed ? '' : tr('detail.trace.ringOnly'))}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function AgentBody({ a }: { a: AgentDetail }) {
  const { t: tr, locale, st } = useLabels();
  const t = a.telemetry;
  const noTelemetry = t.runs === 0;
  return (
    <>
      <div className="mon-detail-title">
        <span className={`mon-dot ${noTelemetry ? 'h-unknown' : H7_DOT[t.overall]}`} />
        <span className="mon-detail-name">{a.name}</span>
        <span className="badge muted">{tr('detail.agent.agents', { count: a.agentCount })}</span>
        {a.running && <span className="badge ok">{tr('detail.agent.running')}</span>}
        {a.scheduled && <span className="badge">{tr('detail.agent.scheduled')}</span>}
        <span className="mon-detail-scope">{a.domain}</span>
      </div>

      <div className="mon-sub">{tr('detail.agent.last7')} <span className="mon-sub-note">{a.langfuseReachable ? tr('detail.agent.source', { source: a.source }) : tr('detail.agent.sourceDown', { source: a.source })}</span></div>
      {noTelemetry ? (
        <p className="hint" style={{ marginTop: 0 }}>
          {tr.rich(a.langfuseReachable ? 'detail.agent.noTelemetry' : 'detail.agent.noTelemetryDown', { link: (c) => <a href={a.links.agent}>{c}</a> })}
        </p>
      ) : (
        <>
          <div className="mon-stats">
            <Stat label={tr('detail.agent.cost')} value={money(t.costUsd, locale)} />
            <Stat label={tr('detail.agent.tokens')} value={compact(t.tokens, locale)} />
            <Stat label={tr('detail.agent.runs')} value={count(t.runs, locale)} />
            <Stat label={tr('detail.agent.lastRun')} value={ago(t.lastRunAt, locale)} />
            <Stat label={tr('detail.agent.warnings')} value={count(t.warnings, locale)} tone={t.warnings > 0 ? 'warn' : undefined} />
            <Stat label={tr('detail.agent.errors')} value={count(t.errors, locale)} tone={t.errors > 0 ? 'error' : undefined} />
          </div>
          <div className="mon-trends">
            <div className="mon-trend"><div className="mon-trend-l">{tr('detail.agent.costTrend')}</div><Spark data={a.costSeries} color="var(--gold, #c8a24a)" /></div>
            <div className="mon-trend"><div className="mon-trend-l">{tr('detail.agent.tokensTrend')}</div><Spark data={a.tokenSeries} color="var(--teal, #4a9d9c)" /></div>
          </div>
        </>
      )}

      <ProfileSection p={a.profile} />
      <LastRunSection r={a.lastRun} />

      <div className="mon-sub">{tr('detail.history.title')} <span className="mon-sub-note">{tr('detail.history.note')}</span></div>
      {a.runs.length === 0 ? (
        <p className="hint" style={{ marginTop: 0 }}>{tr('detail.history.empty')}</p>
      ) : (
        <div className="mon-table">
          <div className="mon-tr mon-th mon-tr-run">
            <span>{tr('detail.history.colTime')}</span><span>{tr('detail.history.colRun')}</span><span>{tr('detail.history.colStatus')}</span><span>{tr('detail.history.colDuration')}</span><span>{tr('detail.history.colCost')}</span><span>{tr('detail.history.colTokens')}</span><span>{tr('detail.history.colModel')}</span>
          </div>
          {a.runs.map((r) =>
            // A row opens ITS OWN trace on the Langfuse console host (r.traceUrl). It has none on a
            // deployment that does not publish Langfuse, or for an in-process record: the row is
            // then plain text, never a link to nowhere.
            r.traceUrl ? (
            <a key={r.id} className="mon-tr mon-tr-run" href={r.traceUrl} target="_blank" rel="noreferrer" title={tr('detail.history.openTrace')}>
              <span className="muted">{ago(r.at, locale)}</span>
              <span className="mono ellip">{r.name}</span>
              <span><span className={`mon-dot ${H7_DOT[r.health]}`} /> {st(r.health)}</span>
              <span>{dur(r.ms, locale)}</span>
              <span>{typeof r.costUsd === 'number' ? money(r.costUsd, locale) : '—'}</span>
              <span>{typeof r.tokens === 'number' ? compact(r.tokens, locale) : '—'}</span>
              <span className="muted ellip">{r.model ?? '—'}</span>
            </a>
            ) : (
            <div key={r.id} className="mon-tr mon-tr-run">
              <span className="muted">{ago(r.at, locale)}</span>
              <span className="mono ellip">{r.name}</span>
              <span><span className={`mon-dot ${H7_DOT[r.health]}`} /> {st(r.health)}</span>
              <span>{dur(r.ms, locale)}</span>
              <span>{typeof r.costUsd === 'number' ? money(r.costUsd, locale) : '—'}</span>
              <span>{typeof r.tokens === 'number' ? compact(r.tokens, locale) : '—'}</span>
              <span className="muted ellip">{r.model ?? '—'}</span>
            </div>
            ),
          )}
        </div>
      )}

      <ToolTraceSection rows={a.toolTrace} />

      {a.issues.length > 0 && (
        <>
          <div className="mon-sub">{tr('detail.agent.issues')}</div>
          <div className="mon-logs">
            {a.issues.map((i, k) => (
              // i18n-ignore — a log line: UTC ISO timestamp and the upper-case level, as in the server's own logs
              <div key={k}>{new Date(i.at).toISOString().replace('T', ' ').slice(0, 19)} {i.health.toUpperCase()} {i.name} — {i.detail}</div>
            ))}
          </div>
        </>
      )}

      <div className="mon-xlinks">
        <a className="mon-xlink" href={a.links.agent}>{tr('detail.agent.openInAgents')}</a>
        {a.links.langfuse ? (
          <a className="mon-xlink" href={a.links.langfuse} target="_blank" rel="noreferrer">{tr('detail.agent.langfuseTraces')}</a>
        ) : null}
      </div>
    </>
  );
}

// ----------------------------------------------------------------- dataset --

const BADGE_TONE: Record<string, string> = { passing: 'ok', failing: 'err', unknown: 'muted' };
const LAYER_KEYS = ['bronze', 'silver', 'gold'] as const;
type Layer = (typeof LAYER_KEYS)[number];

function DatasetBody({ d }: { d: DatasetDetail }) {
  const { t: tr, locale, st } = useLabels();
  const t = d.telemetry;
  const dq = d.dq;
  return (
    <>
      <div className="mon-detail-title">
        <span className={`mon-dot ${H7_DOT[t.overall]}`} />
        <span className="mon-detail-name">{d.name}</span>
        <span className="badge muted">{d.tier}</span>
        <span className="mon-detail-scope">{d.domain}</span>
      </div>

      <div className="mon-sub">{tr('detail.dataset.freshness')}</div>
      <div className="mon-stats">
        <Stat label={tr('detail.dataset.lastBuilt')} value={d.freshness ? ago(d.freshness, locale) : tr('detail.dataset.notBuilt')} />
        <Stat label={tr('detail.dataset.age')} value={d.ageDays == null ? '—' : tr('detail.dataset.ageDays', { days: count(d.ageDays, locale) })} tone={d.ageDays != null && d.ageDays > 30 ? 'error' : d.ageDays != null && d.ageDays > 7 ? 'warn' : undefined} />
        <Stat label={tr('detail.dataset.checksPassing')} value={count(dq.summary.passing, locale)} />
        <Stat label={tr('detail.dataset.violations')} value={count(dq.summary.violated, locale)} tone={dq.summary.violated > 0 ? 'error' : undefined} />
        <Stat label={tr('detail.dataset.warnings')} value={count(t.warnings, locale)} tone={t.warnings > 0 ? 'warn' : undefined} />
      </div>

      {/* ── Data-Quality dashboard ── */}
      <div className="mon-sub">
        {tr('detail.dataset.dq')} {dq.ranAt ? <span className="mon-sub-note">{dq.score != null ? tr('detail.dataset.lastRunScore', { ago: ago(dq.ranAt, locale), score: count(dq.score, locale) }) : tr('detail.dataset.lastRun', { ago: ago(dq.ranAt, locale) })}</span> : null}
        {/* WHO ran it — a dbt test Dagster executed on the last build, or the OS's own ad-hoc
            probe. The two are not interchangeable, so they are never shown as the same thing. */}
        {dq.sourceLabel ? (
          <span className="badge muted" title={dq.sourceLabel.title} style={{ marginLeft: 8 }}>
            {dq.sourceLabel.text}
          </span>
        ) : null}
      </div>
      {!dq.summary.hasRun ? (
        <p className="hint" style={{ marginTop: 0 }}>
          {dq.summary.rules === 0 && dq.checks.length === 0
            ? tr('detail.dataset.noRules')
            : tr('detail.dataset.noRun')}
        </p>
      ) : (
        <>
          <div className="mon-dq-row">
            <span className="badge muted">{tr('detail.dataset.rules', { count: dq.summary.rules })}</span>
            <span className="badge ok">{tr('detail.dataset.passing', { count: count(dq.summary.passing, locale) })}</span>
            {dq.summary.violated > 0 && <span className="badge err">{tr('detail.dataset.violated', { count: count(dq.summary.violated, locale) })}</span>}
            {dq.summary.notRun > 0 && <span className="badge">{tr('detail.dataset.notRunCount', { count: count(dq.summary.notRun, locale) })}</span>}
            {dq.trend.length > 1 && (
              <span style={{ marginLeft: 'auto' }}>
                <Spark data={dq.trend.map((x, i) => ({ day: i, value: x.score ?? 0 }))} color="var(--teal, #4a9d9c)" />
              </span>
            )}
          </div>
          <div className="mon-table">
            <div className="mon-tr mon-th mon-tr-dq"><span>{tr('detail.dataset.colRule')}</span><span>{tr('detail.dataset.colStatus')}</span><span>{tr('detail.dataset.colViolations')}</span></div>
            {dq.checks.map((c) => (
              <div key={c.id} className={`mon-tr mon-tr-dq${c.verdict === 'fail' ? ' err' : ''}`}>
                <span className="mono ellip">{c.label}</span>
                <span>
                  <span className={`mon-dot ${c.verdict === 'fail' ? 'h-red' : c.verdict === 'pass' ? 'h-green' : 'h-unknown'}`} />
                  {st(c.verdict)}
                </span>
                <span>{c.violations == null ? '—' : count(c.violations, locale)}{c.reason ? ` · ${c.reason}` : ''}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {/* ── Build / version timeline ── */}
      <div className="mon-sub">{tr('detail.dataset.medallion')}</div>
      <div className="mon-dq-row">
        {d.layers.map((l) => (
          <span key={l.layer} className={`badge ${l.built ? BADGE_TONE[l.quality] ?? 'muted' : 'muted'}`} style={{ opacity: l.built ? 1 : 0.45 }}>
            {LAYER_KEYS.includes(l.layer as Layer) ? tr(`detail.dataset.layer.${l.layer as Layer}`) : l.layer}{l.built ? '' : ` · ${tr('detail.dataset.notBuilt')}`}{l.built && l.passThrough ? ` · ${tr('detail.dataset.passThrough')}` : ''}{l.updatedAt ? ` · ${ago(l.updatedAt, locale)}` : ''}
          </span>
        ))}
      </div>

      {/* Data versions are the table's Iceberg snapshots (WP-37), shown in the Data tab's Versions panel. */}
      <div className="mon-sub">{tr('detail.dataset.versions')}</div>
      <div className="hint">
        {tr('detail.dataset.versionsHint')}{' '}
        <a href={`/data?focus=${encodeURIComponent(d.id)}&panel=versions`}>{tr('detail.dataset.openVersions')}</a>
      </div>

      {/* ── Lineage ── */}
      {d.lineage.nodes.length > 0 && (
        <>
          <div className="mon-sub">{tr('detail.dataset.lineage')}</div>
          <div className="mon-chain">
            {d.lineage.nodes.map((n, i) => (
              <span key={n.id} style={{ display: 'flex' }}>
                {i > 0 && <span className="mon-hop-arrow">→</span>}
                <span className="mon-hop">
                  <span className="mon-hop-lens">{n.kind}</span>
                  <span className="mon-hop-title">{n.label}</span>
                  <span className="mono" style={{ fontSize: 10, color: 'var(--text-faint)' }}>{n.sublabel}</span>
                </span>
              </span>
            ))}
          </div>
        </>
      )}

      <div className="mon-xlinks"><a className="mon-xlink" href={d.links.data}>{tr('detail.dataset.openInData')}</a></div>
    </>
  );
}
