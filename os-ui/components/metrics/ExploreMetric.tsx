/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  type ExploreResult,
  type MetricSummary,
  ModeBadge,
  leaf,
} from './shared';

type Granularity = 'day' | 'week' | 'month';
const VIEWERS = ['me', 'DE', 'FR', 'US'] as const;
type Viewer = (typeof VIEWERS)[number];

/** Stable column order across rows (first-seen wins) so the table doesn't reshuffle. */
function columnsOf(rows: Record<string, unknown>[]): string[] {
  const cols: string[] = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
  return cols;
}

export default function ExploreMetric({ metric }: { metric: MetricSummary | null }) {
  const [byRegion, setByRegion] = useState(true);
  const [byTime, setByTime] = useState(false);
  const [granularity, setGranularity] = useState<Granularity>('month');
  const [viewer, setViewer] = useState<Viewer>('me');
  const [showSql, setShowSql] = useState(false);

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [result, setResult] = useState<ExploreResult | null>(null);

  const metricId = metric?.id ?? null;

  const run = useCallback(async () => {
    if (!metricId) return;
    setErr(''); setBusy(true);
    const dimensions = byRegion ? ['region'] : [];
    try {
      const res = await fetch('/api/metrics/explore', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          metricId,
          dimensions,
          timeDimension: byTime ? 'order_date' : undefined,
          granularity: byTime ? granularity : undefined,
          viewerRegion: viewer === 'me' ? undefined : viewer,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setErr(data.error ?? 'Explore failed'); setResult(null); return; }
      setResult(data);
    } catch (e) { setErr((e as Error).message); setResult(null); } finally { setBusy(false); }
  }, [metricId, byRegion, byTime, granularity, viewer]);

  // Re-run whenever the slice or the viewer changes — switching viewer is the RLS demo.
  useEffect(() => { run(); }, [run]);

  if (!metric) {
    return (
      <div className="stub-page" style={{ marginTop: 20 }}>
        Pick a metric in <strong>Registry</strong> first, then explore it here.
      </div>
    );
  }

  const cols = result ? columnsOf(result.rows) : [];
  const ctx = result ? Object.entries(result.securityContext) : [];

  return (
    <>
      <p className="lead" style={{ marginTop: 4 }}>
        Slice <strong>{metric.name}</strong> — no SQL. The query runs under <em>your</em>
        delegated identity, so the rows are row-level filtered to the viewer. Change
        <strong> View as</strong> and watch the numbers change: that is Cube RLS, live.
      </p>

      <div className="guided-panel">
        <div className="row" style={{ gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          <label className="chk" style={{ cursor: 'pointer' }}>
            <input type="checkbox" checked={byRegion} onChange={(e) => setByRegion(e.target.checked)} />
            by region
          </label>
          <label className="chk" style={{ cursor: 'pointer' }}>
            <input type="checkbox" checked={byTime} onChange={(e) => setByTime(e.target.checked)} />
            by order_date
          </label>
          {byTime ? (
            <select value={granularity} onChange={(e) => setGranularity(e.target.value as Granularity)}>
              <option value="day">day</option>
              <option value="week">week</option>
              <option value="month">month</option>
            </select>
          ) : null}
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="comp-label" style={{ margin: 0 }}>View as</span>
            <select value={viewer} onChange={(e) => setViewer(e.target.value as Viewer)}>
              {VIEWERS.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
            {busy ? <span className="spin" /> : null}
          </div>
        </div>
      </div>

      {err ? <div className="error" style={{ marginTop: 14 }}>{err}</div> : null}

      {result ? (
        <>
          <div className="section-title" style={{ marginTop: 20 }}>
            Security context
            <ModeBadge mode={result.mode} />
          </div>
          <p className="hint" style={{ marginTop: 0 }}>
            Identity drives the filter — these claims are what Cube applies as RLS for this viewer.
          </p>
          <div className="chip-row">
            {ctx.length ? ctx.map(([k, v]) => (
              <span key={k} className="chip">{k}: {String(v)}</span>
            )) : <span className="hint">no region claim — unfiltered (sees all regions)</span>}
          </div>

          <div className="section-title">
            Result · {result.rows.length} row{result.rows.length === 1 ? '' : 's'}
          </div>
          {result.rows.length === 0 ? (
            <div className="stub-page">No rows for this viewer.</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead><tr>{cols.map((c) => <th key={c}>{leaf(c)}</th>)}</tr></thead>
                <tbody>
                  {result.rows.map((r, i) => (
                    <tr key={i}>{cols.map((c) => <td key={c}>{String(r[c] ?? '')}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <button className={`btn ghost sm${showSql ? ' on' : ''}`} style={{ marginTop: 14 }} onClick={() => setShowSql((v) => !v)}>
            {showSql ? 'Hide SQL' : '‹ › Drop to SQL'}
          </button>
          {showSql ? <pre className="codeblock" style={{ marginTop: 8 }}>{result.sql}</pre> : null}
        </>
      ) : null}
    </>
  );
}
