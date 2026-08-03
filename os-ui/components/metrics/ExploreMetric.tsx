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
  // Cross-filter chips (P1-4) — clicking a category value in the result table narrows the
  // explore to it (the SAME equals shape the governed query pushes into the WHERE). One value
  // per column (Power BI slicer behaviour); session state only, never persisted.
  const [chips, setChips] = useState<{ column: string; value: string }[]>([]);

  // When sliceMembers load, seed a sensible default (first non-time column)
  useEffect(() => {
    setSelectedDims([]);
    setSelectedTime('');
    setChips([]);
  }, [metric?.id]);

  const metricId = metric?.id ?? null;

  const toggleDim = (col: string) =>
    setSelectedDims((ds) => ds.includes(col) ? ds.filter((d) => d !== col) : [...ds, col]);

  // Click a category value → add/replace/clear its chip (one value per column).
  const toggleChip = (column: string, value: string) =>
    setChips((cs) => {
      const same = cs.find((c) => c.column === column);
      if (same && same.value === value) return cs.filter((c) => c.column !== column); // click again = clear
      return [...cs.filter((c) => c.column !== column), { column, value }];
    });

  // Serialize chips so the fetch re-runs when they change (stable key, not identity).
  const chipsKey = JSON.stringify(chips);
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
          filters: chips.length ? chips.map((c) => ({ column: c.column, values: [c.value] })) : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setErr(data.error ?? 'Explore failed'); setResult(null); return; }
      setResult(data);
    } catch (e) { setErr((e as Error).message); setResult(null); } finally { setBusy(false); }
    // chips are captured via chipsKey (stable string) to re-run on change without identity churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metricId, selectedDims, selectedTime, granularity, viewer, chipsKey]);

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
      <div className="section-title" style={{ marginTop: 4 }}>Explore</div>

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

      {/* Cross-filter chips (P1-4) — the explorer narrows to these; every re-runs under RLS. */}
      {chips.length > 0 ? (
        <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 14 }}>
          <span className="hint" style={{ margin: 0 }}>Filtered to</span>
          {chips.map((c) => (
            <span key={c.column} className="chip ok" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {leaf(c.column)} = {c.value}
              <button
                className="chip-x"
                onClick={() => setChips((cs) => cs.filter((x) => x.column !== c.column))}
                aria-label={`Clear filter ${leaf(c.column)}`}
              >×</button>
            </span>
          ))}
          {chips.length > 1 ? <button className="btn ghost sm" onClick={() => setChips([])}>Clear all</button> : null}
        </div>
      ) : null}

      {err ? <div className="error" style={{ marginTop: 14 }}>{err}</div> : null}

      {result?.warning ? (
        <div className="error" style={{ marginTop: 14, background: 'rgba(200,120,20,.10)', borderColor: 'rgba(200,120,20,.4)' }}>
          {result.warning}
        </div>
      ) : null}

      {result ? (
        <>
          <div className="section-title" style={{ marginTop: 20 }}>
            Security context
            <ModeBadge mode={result.mode} />
          </div>
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
            <div className="stub-page">
              {result.unavailable ? 'No number shown — the semantic layer is unavailable.' : 'No rows for this viewer.'}
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead><tr>{cols.map((c) => <th key={c}>{leaf(c)}</th>)}</tr></thead>
                <tbody>
                  {result.rows.map((r, i) => (
                    <tr key={i}>{cols.map((c) => {
                      const raw = r[c];
                      const text = String(raw ?? '');
                      // A CATEGORY cell (not the measure member, non-empty) is clickable — it
                      // adds a cross-filter chip and re-runs the explore narrowed to it (P1-4).
                      const filterable = c !== result.member && text !== '';
                      return filterable ? (
                        <td key={c}>
                          <button
                            className="linklike"
                            onClick={() => toggleChip(c, text)}
                            title={`Filter to ${leaf(c)} = ${text}`}
                            style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', color: 'inherit', font: 'inherit', textDecoration: 'underline dotted' }}
                          >{text}</button>
                        </td>
                      ) : (
                        <td key={c}>{text}</td>
                      );
                    })}</tr>
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
