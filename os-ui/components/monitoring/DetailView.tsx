/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect, useState } from 'react';

/**
 * The DIAGNOSIS view — opened from an agent or dataset tile IN THE MAIN WINDOW
 * (tab-consistent with Data's DataBuilder and Agents' SystemView: the tile grid
 * swaps to this full view; "← Monitoring" returns). Read-only. Fetches its
 * payload on mount; 403/404 surface calmly.
 *
 * Agent sections: 7-day telemetry (honest source line) · system profile (nodes,
 * trigger, grants) · last-run report (OS run store, per-node drill-down) · run
 * history (Langfuse + in-process ring, merged) · governed tool calls (ring —
 * exists even with Langfuse down) · errors & warnings. Dataset sections: the DQ
 * dashboard, medallion build, versions and lineage, unchanged.
 */

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
  runs: { id: string; at: number; name: string; model?: string; decision?: string; health: Health7; costUsd?: number; tokens?: number; ms?: number; source: string }[];
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
  telemetry: { checksPassing: number; checksFailing: number; checksNotRun: number; warnings: number; errors: number; overall: Health7 };
  dq: {
    summary: { rules: number; passing: number; violated: number; notRun: number; hasRun: boolean; violatedRules: { id: string; label: string; violations: number | null }[] };
    ranAt: string | null; score: number | null;
    trend: { ranAt: string; score: number | null; badge: string }[];
    checks: DqCheck[];
  };
  layers: { layer: string; built: boolean; passThrough: boolean; quality: string; updatedAt: string | null }[];
  versions: { version: number; at: string; author: string; summary: string }[];
  lineage: { nodes: { id: string; kind: string; label: string; sublabel: string; built: boolean }[]; edges: { from: string; to: string; kind: string }[] };
  links: { data: string };
};

export type DetailTarget = { kind: 'agent' | 'dataset'; id: string; name?: string };

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
const money = (n: number) => (n >= 1 ? `€${n.toFixed(2)}` : n > 0 ? `€${n.toFixed(3)}` : '—');
const compact = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);
const dur = (ms?: number) => (typeof ms !== 'number' ? '—' : ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`);
const H7_DOT: Record<Health7, string> = { ok: 'h-green', warn: 'h-amber', error: 'h-red' };
const DECISION_DOT: Record<string, string> = { allow: 'h-green', deny: 'h-red', requires_approval: 'h-amber' };

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
          setErr(res.status === 403 ? 'This artifact is out of your scope.' : res.status === 404 ? 'Not found.' : body.error ?? `Failed (${res.status})`);
        } else if (target.kind === 'agent') setAgent(body.detail as AgentDetail);
        else setDataset(body.detail as DatasetDetail);
      })
      .catch((e) => { if (live) setErr((e as Error).message); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [target.id, target.kind]);

  return (
    <>
      <div className="row" style={{ alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <button className="btn ghost" onClick={onBack}>← Monitoring</button>
        <span className="crumb">{target.kind === 'agent' ? 'Agent diagnostics' : 'Dataset diagnostics'}</span>
      </div>
      {loading && <div style={{ marginTop: 8 }}><span className="spin" /> <span className="muted">Loading…</span></div>}
      {err && <div className="error" style={{ marginTop: 8 }}>{err}</div>}
      {agent && <AgentBody a={agent} />}
      {dataset && <DatasetBody d={dataset} />}
    </>
  );
}

// ------------------------------------------------------------------- agent --

function ProfileSection({ p }: { p: SystemProfile | null }) {
  if (!p) {
    return (
      <>
        <div className="mon-sub">System profile</div>
        <p className="hint" style={{ marginTop: 0 }}>Profile unavailable — this system&apos;s definition could not be parsed.</p>
      </>
    );
  }
  const granted = p.grants.filter((g) => g.count > 0);
  return (
    <>
      <div className="mon-sub">System profile</div>
      {p.description && <p className="hint" style={{ marginTop: 0, marginBottom: 8 }}>{p.description}</p>}
      <div className="mon-dq-row">
        <span className="badge muted">runtime · {p.runtime}</span>
        <span className="badge muted">safety · {p.safetyPreset}</span>
        <span className="badge">{p.trigger}</span>
        {p.tools.length > 0 && <span className="badge muted">{p.tools.length} tool{p.tools.length === 1 ? '' : 's'} · {p.tools.join(', ')}</span>}
      </div>
      <div className="mon-table">
        <div className="mon-tr mon-th mon-tr-node"><span>Agent</span><span>Role</span><span>Model</span><span /></div>
        {p.nodes.map((n) => (
          <div key={n.id} className="mon-tr mon-tr-node">
            <span className="mono ellip">{n.id}</span>
            <span className="ellip">{n.role}</span>
            <span className="muted ellip">{n.model}</span>
            <span>
              {n.entry && <span className="badge muted">entry</span>}{' '}
              {n.supervisor && <span className="badge muted">supervisor</span>}{' '}
              {n.disabled && <span className="badge err">off</span>}
            </span>
          </div>
        ))}
      </div>
      {granted.length === 0 ? (
        <p className="hint" style={{ marginTop: 8 }}>No data/knowledge/files/connection grants — this team runs on its tools only.</p>
      ) : (
        granted.map((g) => (
          <div key={g.kind} className="mon-dq-row" style={{ marginTop: 8, marginBottom: 0 }}>
            <span className="badge muted">{g.kind} · {g.count}</span>
            {g.rows.slice(0, 6).map((r) => (
              <span key={r.id + r.name} className="badge" title={r.capability}>{r.name}</span>
            ))}
            {g.count > 6 && <span className="muted" style={{ fontSize: 12 }}>+{g.count - 6} more</span>}
          </div>
        ))
      )}
    </>
  );
}

function LastRunSection({ r }: { r: LastRunReport | null }) {
  return (
    <>
      <div className="mon-sub">
        Last run report{r ? <span className="mon-sub-note">OS run store · {ago(r.at)}</span> : null}
      </div>
      {!r ? (
        <p className="hint" style={{ marginTop: 0 }}>No interactive run recorded yet — run this team in the Agents tab.</p>
      ) : (
        <>
          <div className="mon-dq-row">
            {r.running
              ? <span className="badge">running…</span>
              : <span className={`badge ${r.ok ? 'ok' : 'err'}`}>{r.ok ? 'succeeded' : 'failed'}</span>}
            <span className="badge muted">{r.trigger}</span>
            {r.path.length > 0 && <span className="badge muted mono">{r.path.join(' → ')}</span>}
            {r.held > 0 && <span className="badge">⚠ {r.held} held for approval</span>}
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
                    <span className="muted">{n.steps.length} step{n.steps.length === 1 ? '' : 's'} · {n.status}</span>
                  </summary>
                  <div className="mon-node-body">
                    {n.tierReason && <p className="hint" style={{ marginTop: 0 }}>Model routing: {n.tierReason}</p>}
                    {n.error && <div className="error" style={{ marginBottom: 8 }}>{n.error}</div>}
                    {n.input && <div className="mon-logs" style={{ marginBottom: 8 }}>in&nbsp;· {n.input}</div>}
                    {n.steps.length > 0 && (
                      <div className="mon-table">
                        <div className="mon-tr mon-th mon-tr-step"><span>Tool</span><span>Status</span><span>Summary</span></div>
                        {n.steps.map((s, i) => (
                          <div key={i} className={`mon-tr mon-tr-step${s.isError ? ' err' : ''}`}>
                            <span className="mono ellip">{s.tool}</span>
                            <span><span className={`mon-dot ${s.isError ? 'h-red' : 'h-green'}`} /> {s.isError ? 'error' : 'ok'}</span>
                            <span className="ellip">{s.summary ?? '—'}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {n.finalText && <div className="mon-logs" style={{ marginTop: 8 }}>out · {n.finalText}</div>}
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
  return (
    <>
      <div className="mon-sub">Governed tool calls <span className="mon-sub-note">in-process policy trace · independent of Langfuse</span></div>
      {rows.length === 0 ? (
        <p className="hint" style={{ marginTop: 0 }}>No governed tool calls recorded in this process yet.</p>
      ) : (
        <div className="mon-table">
          <div className="mon-tr mon-th mon-tr-trace"><span>Time</span><span>Tool</span><span>Agent</span><span>Decision</span><span>Detail</span></div>
          {rows.map((t, i) => (
            <div key={i} className={`mon-tr mon-tr-trace${t.decision === 'deny' ? ' err' : ''}`}>
              <span className="muted">{ago(t.at)}</span>
              <span className="mono ellip">{t.tool}</span>
              <span className="mono ellip">{t.node ?? '—'}</span>
              <span><span className={`mon-dot ${DECISION_DOT[t.decision] ?? 'h-unknown'}`} /> {t.decision}</span>
              <span className="ellip">{t.detail ?? (t.landed ? '' : 'ring only')}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function AgentBody({ a }: { a: AgentDetail }) {
  const t = a.telemetry;
  const noTelemetry = t.runs === 0;
  return (
    <>
      <div className="mon-detail-title">
        <span className={`mon-dot ${noTelemetry ? 'h-unknown' : H7_DOT[t.overall]}`} />
        <span className="mon-detail-name">{a.name}</span>
        <span className="badge muted">{a.agentCount} agent{a.agentCount === 1 ? '' : 's'}</span>
        {a.running && <span className="badge ok">running</span>}
        {a.scheduled && <span className="badge">scheduled</span>}
        <span className="mon-detail-scope">{a.domain}</span>
      </div>

      <div className="mon-sub">Last 7 days <span className="mon-sub-note">source: {a.source}{a.langfuseReachable ? '' : ' · Langfuse unreachable'}</span></div>
      {noTelemetry ? (
        <p className="hint" style={{ marginTop: 0 }}>
          No telemetry yet{a.langfuseReachable ? '' : ' · Langfuse unreachable — showing in-process runs only'}. Run this agent in the <a href={a.links.agent}>Agents</a> tab.
        </p>
      ) : (
        <>
          <div className="mon-stats">
            <Stat label="Cost" value={money(t.costUsd)} />
            <Stat label="Tokens" value={compact(t.tokens)} />
            <Stat label="Runs" value={t.runs} />
            <Stat label="Last run" value={ago(t.lastRunAt)} />
            <Stat label="Warnings" value={t.warnings} tone={t.warnings > 0 ? 'warn' : undefined} />
            <Stat label="Errors" value={t.errors} tone={t.errors > 0 ? 'error' : undefined} />
          </div>
          <div className="mon-trends">
            <div className="mon-trend"><div className="mon-trend-l">Cost · 7d</div><Spark data={a.costSeries} color="var(--gold, #c8a24a)" /></div>
            <div className="mon-trend"><div className="mon-trend-l">Tokens · 7d</div><Spark data={a.tokenSeries} color="var(--teal, #4a9d9c)" /></div>
          </div>
        </>
      )}

      <ProfileSection p={a.profile} />
      <LastRunSection r={a.lastRun} />

      <div className="mon-sub">Run history <span className="mon-sub-note">Langfuse + in-process ring, merged</span></div>
      {a.runs.length === 0 ? (
        <p className="hint" style={{ marginTop: 0 }}>No runs recorded in the window.</p>
      ) : (
        <div className="mon-table">
          <div className="mon-tr mon-th mon-tr-run">
            <span>Time</span><span>Run</span><span>Status</span><span>Duration</span><span>Cost</span><span>Tokens</span><span>Model</span>
          </div>
          {a.runs.map((r) => (
            <a key={r.id} className="mon-tr mon-tr-run" href={a.links.langfuse} target="_blank" rel="noreferrer" title="Open in Langfuse">
              <span className="muted">{ago(r.at)}</span>
              <span className="mono ellip">{r.name}</span>
              <span><span className={`mon-dot ${H7_DOT[r.health]}`} /> {r.health}</span>
              <span>{dur(r.ms)}</span>
              <span>{typeof r.costUsd === 'number' ? money(r.costUsd) : '—'}</span>
              <span>{typeof r.tokens === 'number' ? compact(r.tokens) : '—'}</span>
              <span className="muted ellip">{r.model ?? '—'}</span>
            </a>
          ))}
        </div>
      )}

      <ToolTraceSection rows={a.toolTrace} />

      {a.issues.length > 0 && (
        <>
          <div className="mon-sub">Errors &amp; warnings</div>
          <div className="mon-logs">
            {a.issues.map((i, k) => (
              <div key={k}>{new Date(i.at).toISOString().replace('T', ' ').slice(0, 19)} {i.health.toUpperCase()} {i.name} — {i.detail}</div>
            ))}
          </div>
        </>
      )}

      <div className="mon-xlinks">
        <a className="mon-xlink" href={a.links.agent}>→ Open agent in Agents</a>
        <a className="mon-xlink" href={a.links.langfuse} target="_blank" rel="noreferrer">→ Langfuse traces</a>
      </div>
    </>
  );
}

// ----------------------------------------------------------------- dataset --

const BADGE_TONE: Record<string, string> = { passing: 'ok', failing: 'err', unknown: 'muted' };

function DatasetBody({ d }: { d: DatasetDetail }) {
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

      <div className="mon-sub">Freshness &amp; health</div>
      <div className="mon-stats">
        <Stat label="Last built" value={d.freshness ? ago(d.freshness) : 'not built'} />
        <Stat label="Age" value={d.ageDays == null ? '—' : `${d.ageDays}d`} tone={d.ageDays != null && d.ageDays > 30 ? 'error' : d.ageDays != null && d.ageDays > 7 ? 'warn' : undefined} />
        <Stat label="Checks passing" value={dq.summary.passing} />
        <Stat label="Violations" value={dq.summary.violated} tone={dq.summary.violated > 0 ? 'error' : undefined} />
        <Stat label="Warnings" value={t.warnings} tone={t.warnings > 0 ? 'warn' : undefined} />
      </div>

      {/* ── Data-Quality dashboard ── */}
      <div className="mon-sub">Data quality {dq.ranAt ? <span className="mon-sub-note">last run {ago(dq.ranAt)}{dq.score != null ? ` · ${dq.score}/100` : ''}</span> : null}</div>
      {!dq.summary.hasRun ? (
        <p className="hint" style={{ marginTop: 0 }}>
          {dq.summary.rules === 0 && dq.checks.length === 0
            ? 'No DQ rules defined for this dataset yet — add checks in the Data tab.'
            : 'No DQ run recorded yet — run the checks in the Data tab.'}
        </p>
      ) : (
        <>
          <div className="mon-dq-row">
            <span className="badge muted">{dq.summary.rules} rule{dq.summary.rules === 1 ? '' : 's'}</span>
            <span className="badge ok">{dq.summary.passing} passing</span>
            {dq.summary.violated > 0 && <span className="badge err">{dq.summary.violated} violated</span>}
            {dq.summary.notRun > 0 && <span className="badge">{dq.summary.notRun} not run</span>}
            {dq.trend.length > 1 && (
              <span style={{ marginLeft: 'auto' }}>
                <Spark data={dq.trend.map((x, i) => ({ day: i, value: x.score ?? 0 }))} color="var(--teal, #4a9d9c)" />
              </span>
            )}
          </div>
          <div className="mon-table">
            <div className="mon-tr mon-th mon-tr-dq"><span>Rule</span><span>Status</span><span>Violations</span></div>
            {dq.checks.map((c) => (
              <div key={c.id} className={`mon-tr mon-tr-dq${c.verdict === 'fail' ? ' err' : ''}`}>
                <span className="mono ellip">{c.label}</span>
                <span>
                  <span className={`mon-dot ${c.verdict === 'fail' ? 'h-red' : c.verdict === 'pass' ? 'h-green' : 'h-unknown'}`} />
                  {c.verdict === 'not_run' ? 'not run' : c.verdict}
                </span>
                <span>{c.violations == null ? '—' : c.violations}{c.reason ? ` · ${c.reason}` : ''}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {/* ── Build / version timeline ── */}
      <div className="mon-sub">Medallion build</div>
      <div className="mon-dq-row">
        {d.layers.map((l) => (
          <span key={l.layer} className={`badge ${l.built ? BADGE_TONE[l.quality] ?? 'muted' : 'muted'}`} style={{ opacity: l.built ? 1 : 0.45 }}>
            {l.layer}{l.built ? '' : ' · not built'}{l.built && l.passThrough ? ' · pass-through' : ''}{l.updatedAt ? ` · ${ago(l.updatedAt)}` : ''}
          </span>
        ))}
      </div>

      {d.versions.length > 0 && (
        <>
          <div className="mon-sub">Version history</div>
          <div className="mon-table">
            <div className="mon-tr mon-th mon-tr-ver"><span>#</span><span>When</span><span>Author</span><span>Change</span></div>
            {d.versions.slice(0, 12).map((v) => (
              <div key={v.version} className="mon-tr mon-tr-ver">
                <span className="muted">v{v.version}</span>
                <span className="muted">{ago(v.at)}</span>
                <span className="ellip">{v.author}</span>
                <span className="ellip">{v.summary}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {/* ── Lineage ── */}
      {d.lineage.nodes.length > 0 && (
        <>
          <div className="mon-sub">Lineage</div>
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

      <div className="mon-xlinks"><a className="mon-xlink" href={d.links.data}>→ Open dataset in Data</a></div>
    </>
  );
}
