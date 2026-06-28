/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import PageHeader from '@/components/PageHeader';
import { useApi } from '@/lib/useApi';

type Anno = { name: string; title: string; shortTitle?: string; type?: string };
type Data = {
  cube: string;
  measures: Anno[];
  dimensions: Anno[];
  columns: string[];
  rows: string[][];
  rowCount: number;
};

export default function MetricsPage() {
  const { data, loading, error, reload } = useApi<Data>('/api/metrics');

  return (
    <>
      <PageHeader title="Metrics" crumb="business metrics, defined once — Cube semantic layer" />
      <div className="content">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <p className="lead" style={{ marginBottom: 0 }}>
            One consistent definition of every metric — grain, dimensions, and measures —
            served from the Cube semantic layer to dashboards and agents alike. Below is the{' '}
            <code>daily_revenue</code> cube, queried live through Cube&apos;s REST API
            server-side.
          </p>
          <button className="btn ghost" onClick={reload} disabled={loading}>
            {loading ? <span className="spin" /> : 'Refresh'}
          </button>
        </div>

        {error ? <div className="error" style={{ marginTop: 20 }}>{error}</div> : null}

        {data ? (
          <>
            <div className="section-title">
              Cube · <code>{data.cube}</code>
            </div>
            <div className="grid">
              {data.measures.map((m) => (
                <div className="card" key={m.name}>
                  <h3>Measure</h3>
                  <div className="big">{m.shortTitle ?? m.title}</div>
                  <div className="muted mono" style={{ fontSize: 11.5, marginTop: 4 }}>
                    {m.name}
                  </div>
                  <div className="muted">{m.type ?? 'number'}</div>
                </div>
              ))}
              {data.dimensions.map((d) => (
                <div className="card" key={d.name}>
                  <h3>Dimension</h3>
                  <div className="big">{d.shortTitle ?? d.title}</div>
                  <div className="muted mono" style={{ fontSize: 11.5, marginTop: 4 }}>
                    {d.name}
                  </div>
                  <div className="muted">{d.type ?? 'string'}</div>
                </div>
              ))}
            </div>

            <div className="section-title">
              Result · {data.rowCount} row{data.rowCount === 1 ? '' : 's'}
            </div>
            {data.rows.length === 0 ? (
              <div className="stub-page">
                Cube returned no rows — materialize <code>analytics.daily_revenue</code> first.
              </div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      {data.columns.map((c) => (
                        <th key={c}>{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((r, i) => (
                      <tr key={i}>
                        {r.map((cell, j) => (
                          <td key={j}>{cell}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="hint">
              Defined in the Cube data model and consumed by Superset + agents. Set{' '}
              <code>CUBE_URL</code> for the REST API (default <code>http://cube:4000</code>).
              Add a metric by editing the Cube model and redeploying.
            </div>
          </>
        ) : loading ? (
          <div className="stub-page" style={{ marginTop: 20 }}>Loading metrics…</div>
        ) : null}
      </div>
    </>
  );
}
