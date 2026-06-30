/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useApi } from '@/lib/useApi';

type Anno = { name: string; title: string; shortTitle?: string; type?: string };
type Cube = {
  cube: string;
  measures: Anno[];
  dimensions: Anno[];
  columns: string[];
  rows: string[][];
  rowCount: number;
};

/**
 * The canonical `daily_revenue` cube, served read-only from the platform model — a quiet
 * inspection of the live semantic layer the metrics resolve against.
 */
export default function LiveCube() {
  const { data, loading, error, reload } = useApi<Cube>('/api/metrics/cube-preview');

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
        <div className="section-title" style={{ margin: 0 }}>Cube · <code>{data?.cube ?? 'daily_revenue'}</code></div>
        <button className="btn ghost" onClick={reload} disabled={loading}>{loading ? <span className="spin" /> : 'Refresh'}</button>
      </div>

      {error ? <div className="error" style={{ marginTop: 16 }}>{error}</div> : null}

      {data ? (
        <>
          <div className="grid" style={{ marginTop: 14 }}>
            {data.measures.map((m) => (
              <div className="card" key={m.name}>
                <h3>Measure</h3>
                <div className="big">{m.shortTitle ?? m.title}</div>
                <div className="muted mono" style={{ fontSize: 11.5, marginTop: 4 }}>{m.name}</div>
                <div className="muted">{m.type ?? 'number'}</div>
              </div>
            ))}
            {data.dimensions.map((d) => (
              <div className="card" key={d.name}>
                <h3>Dimension</h3>
                <div className="big">{d.shortTitle ?? d.title}</div>
                <div className="muted mono" style={{ fontSize: 11.5, marginTop: 4 }}>{d.name}</div>
                <div className="muted">{d.type ?? 'string'}</div>
              </div>
            ))}
          </div>
          <div className="section-title">Result · {data.rowCount} row{data.rowCount === 1 ? '' : 's'}</div>
          {data.rows.length === 0 ? (
            <div className="stub-page">Cube returned no rows — materialize <code>analytics.daily_revenue</code> first.</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead><tr>{data.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
                <tbody>{data.rows.map((r, i) => <tr key={i}>{r.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody>
              </table>
            </div>
          )}
        </>
      ) : loading ? (
        <div className="stub-page" style={{ marginTop: 16 }}>Loading the live cube…</div>
      ) : null}
    </>
  );
}
