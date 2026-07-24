/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect, useState } from 'react';

/**
 * The big DIAGNOSIS WINDOW — a wide overlay opened from an agent or dataset tile
 * with ALL the diagnostics in one scannable, sectioned view. Reuses the OS drawer
 * backdrop; the `.mon-detail` panel widens it to a near-full-screen inspector.
 * Read-only. Fetches its payload on open; 403/404 surface calmly.
 */

type Health7 = 'ok' | 'warn' | 'error';

type AgentDetail = {
  id: string; name: string; domain: string; agentCount: number;
  running: boolean; scheduled: boolean;
  telemetry: { costUsd: number; tokens: number; runs: number; lastRunAt: number | null; warnings: number; errors: number; overall: Health7 };
  costSeries: { day: number; value: number }[];
  tokenSeries: { day: number; value: number }[];
  runs: { id: string; at: number; name: string; model?: string; decision?: string; health: Health7; costUsd?: number; tokens?: number; ms?: number; source: string }[];
  issues: { at: number; name: string; health: 'warn' | 'error'; detail: string }[];
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

export type DetailTarget = { kind: 'agent' | 'dataset'; id: string; name: string };

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
const money = (n: number) => (n >= 1 ? `$${n.toFixed(2)}` : n > 0 ? `$${n.toFixed(3)}` : '$0');
const compact = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);
const H7_DOT: Record<Health7, string> = { ok: 'h-green', warn: 'h-amber', error: 'h-red' };

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

export default function DetailWindow({ target, onClose }: { target: DetailTarget; onClose: () => void }) {
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <section className="mon-detail" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="drawer-head">
          <h2>{target.kind === 'agent' ? 'Agent diagnostics' : 'Dataset diagnostics'}</h2>
          <button className="drawer-x" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="mon-detail-body">
          {loading && <div style={{ marginTop: 8 }}><span className="spin" /> <span className="muted">Loading…</span></div>}
          {err && <div className="error" style={{ marginTop: 8 }}>{err}</div>}
          {agent && <AgentBody a={agent} />}
          {dataset && <DatasetBody d={dataset} />}
        </div>
      </section>
    </div>
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

      <div className="mon-sub">Last 7 days</div>
      {noTelemetry ? (
        <p className="hint" style={{ marginTop: 0 }}>
          No telemetry yet{a.langfuseReachable ? '' : ' · Langfuse unreachable — showing in-process runs only'}. Run this agent in the <a href={a.links.agent}>Agents</a> tab.
        </p>
      ) : (
        <div className="mon-stats">
          <Stat label="Cost" value={money(t.costUsd)} />
          <Stat label="Tokens" value={compact(t.tokens)} />
          <Stat label="Runs" value={t.runs} />
          <Stat label="Last run" value={ago(t.lastRunAt)} />
          <Stat label="Warnings" value={t.warnings} tone={t.warnings > 0 ? 'warn' : undefined} />
          <Stat label="Errors" value={t.errors} tone={t.errors > 0 ? 'error' : undefined} />
        </div>
      )}

      {!noTelemetry && (
        <div className="mon-trends">
          <div className="mon-trend"><div className="mon-trend-l">Cost · 7d</div><Spark data={a.costSeries} color="var(--gold, #c8a24a)" /></div>
          <div className="mon-trend"><div className="mon-trend-l">Tokens · 7d</div><Spark data={a.tokenSeries} color="var(--teal, #4a9d9c)" /></div>
        </div>
      )}

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

      <div className="mon-sub">Run history</div>
      {a.runs.length === 0 ? (
        <p className="hint" style={{ marginTop: 0 }}>No runs recorded in the window.</p>
      ) : (
        <div className="mon-table">
          <div className="mon-tr mon-th">
            <span>Time</span><span>Run</span><span>Status</span><span>Cost</span><span>Tokens</span><span>Model</span>
          </div>
          {a.runs.map((r) => (
            <a key={r.id} className="mon-tr" href={a.links.langfuse} target="_blank" rel="noreferrer" title="Open in Langfuse">
              <span className="muted">{ago(r.at)}</span>
              <span className="mono ellip">{r.name}</span>
              <span><span className={`mon-dot ${H7_DOT[r.health]}`} /> {r.health}</span>
              <span>{typeof r.costUsd === 'number' ? money(r.costUsd) : '—'}</span>
              <span>{typeof r.tokens === 'number' ? compact(r.tokens) : '—'}</span>
              <span className="muted ellip">{r.model ?? '—'}</span>
            </a>
          ))}
        </div>
      )}

      <div className="mon-xlinks">
        <a className="mon-xlink" href={a.links.agent}>→ Open agent in Agents</a>
        <a className="mon-xlink" href={a.links.langfuse} target="_blank" rel="noreferrer">→ Langfuse traces</a>
      </div>
      <p className="hint" style={{ opacity: 0.6, marginTop: 12 }}>Telemetry source: {a.source}{a.langfuseReachable ? '' : ' (Langfuse unreachable)'}.</p>
    </>
  );
}

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
