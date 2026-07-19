/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
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

type DatasetColumn = { name: string };

/** Fetch the dataset's real columns for dynamic dimension/time pickers. */
function useDatasetColumns(datasetId: string | undefined): { sliceMembers: string[]; timeColumns: string[] } {
  const [columns, setColumns] = useState<string[]>([]);
  useEffect(() => {
    if (!datasetId) { setColumns([]); return; }
    let live = true;
    (async () => {
      try {
        const res = await fetch(`/api/data/datasets/${datasetId}`, { cache: 'no-store' });
        if (res.ok && live) {
          const data = await res.json();
          const cols = ((data?.dataset?.columns ?? []) as DatasetColumn[]).map((c) => c.name).filter(Boolean);
          setColumns(cols);
        }
      } catch { if (live) setColumns([]); }
    })();
    return () => { live = false; };
  }, [datasetId]);

  const sliceMembers = useMemo(() => {
    const pk = columns.find((c) => /(^|_)id$/.test(c.toLowerCase())) ?? columns[0];
    return columns.filter((c) => c !== pk);
  }, [columns]);

  const timeColumns = useMemo(
    () => columns.filter((c) => /(_at|_date|_ts|_time|date|timestamp)$/i.test(c) || c.toLowerCase() === 'date'),
    [columns],
  );

  return { sliceMembers, timeColumns };
}

export default function ExploreMetric({ metric }: { metric: MetricSummary | null }) {
  const { sliceMembers, timeColumns } = useDatasetColumns(metric?.datasetId);

  // Selected dimensions (toggled checkboxes from the dataset's real columns)
  const [selectedDims, setSelectedDims] = useState<string[]>([]);
  const [selectedTime, setSelectedTime] = useState('');
  const [granularity, setGranularity] = useState<Granularity>('month');
  const [viewer, setViewer] = useState<Viewer>('me');
  const [showSql, setShowSql] = useState(false);

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [result, setResult] = useState<ExploreResult | null>(null);

  // When sliceMembers load, seed a sensible default (first non-time column)
  useEffect(() => {
    setSelectedDims([]);
    setSelectedTime('');
  }, [metric?.id]);

  const metricId = metric?.id ?? null;

  const toggleDim = (col: string) =>
    setSelectedDims((ds) => ds.includes(col) ? ds.filter((d) => d !== col) : [...ds, col]);

  const run = useCallback(async () => {
    if (!metricId) return;
    setErr(''); setBusy(true);
    try {
      const res = await fetch('/api/metrics/explore', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          metricId,
          dimensions: selectedDims,
          timeDimension: selectedTime || undefined,
          granularity: selectedTime ? granularity : undefined,
          viewerRegion: viewer === 'me' ? undefined : viewer,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setErr(data.error ?? 'Explore failed'); setResult(null); return; }
      setResult(data);
    } catch (e) { setErr((e as Error).message); setResult(null); } finally { setBusy(false); }
  }, [metricId, selectedDims, selectedTime, granularity, viewer]);

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
          {sliceMembers.length > 0 ? (
            sliceMembers.map((col) => (
              <label key={col} className="chk" style={{ cursor: 'pointer' }}>
                <input type="checkbox" checked={selectedDims.includes(col)} onChange={() => toggleDim(col)} />
                by {col}
              </label>
            ))
          ) : (
            <span className="hint">no dimensions available</span>
          )}
          {timeColumns.length > 0 ? (
            <select
              value={selectedTime}
              onChange={(e) => setSelectedTime(e.target.value)}
              style={{ minWidth: 120 }}
            >
              <option value="">no time slice</option>
              {timeColumns.map((c) => <option key={c} value={c}>by {c}</option>)}
            </select>
          ) : null}
          {selectedTime ? (
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
          {selectedTime && result.mode === 'offline-mock' ? (
            <p className="hint" style={{ marginTop: 0 }}>
              Offline mock returns totals only — the time-series slice resolves against live Cube.
            </p>
          ) : null}
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
