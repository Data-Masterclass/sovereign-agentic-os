/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useState } from 'react';

type Layer = 'bronze' | 'silver' | 'gold';

type Preview = {
  available: boolean;
  reason?: string;
  layer?: Layer;
  fqn?: string;
  limit?: number;
  columns?: string[];
  rows?: string[][];
  rowCount?: number;
};

/**
 * Preview data — "let me scan through a subset." A fast, governed `SELECT * … LIMIT n`
 * over one built version, shown as a plain table. It runs the caller's OWN read path,
 * so the rows are already scoped + masked to what the viewer may see. Unlike the fuller
 * profile, it does no stats fan-out — it just shows rows immediately, and answers a
 * not-yet-materialized version with a calm "build it first" line, never a Trino error.
 */
export default function PreviewPanel({ datasetId, builtLayers }: { datasetId: string; builtLayers: Layer[] }) {
  const order: Layer[] = ['bronze', 'silver', 'gold'];
  const layers = order.filter((l) => builtLayers.includes(l));
  const [layer, setLayer] = useState<Layer>(layers[layers.length - 1] ?? 'bronze');
  const [data, setData] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async (which: Layer) => {
    setBusy(true); setErr(''); setData(null);
    try {
      const res = await fetch(`/api/data/datasets/${datasetId}/preview?layer=${which}&limit=50`, { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) { setErr(body.error ?? 'Could not preview this version'); return; }
      setData(body);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }, [datasetId]);

  useEffect(() => { if (layers.length) load(layer); }, [layer, load]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!layers.length) {
    return <div className="guided-panel"><p className="muted" style={{ marginTop: 0 }}>Build a version to preview its rows.</p></div>;
  }

  const cols = data?.columns ?? [];
  const rows = data?.rows ?? [];

  return (
    <div className="guided-panel">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
        <p className="muted" style={{ margin: 0 }}>
          A quick scan of the actual rows — run as you, masked to what you can see.
        </p>
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          {layers.length > 1 ? (
            <div className="seg">
              {layers.map((l) => (
                <button key={l} className={layer === l ? 'on' : ''} onClick={() => setLayer(l)}>{l}</button>
              ))}
            </div>
          ) : null}
          <button className="btn ghost sm" onClick={() => load(layer)} disabled={busy}>
            {busy ? <span className="spin" /> : 'Refresh'}
          </button>
        </div>
      </div>

      {err ? <div className="error" style={{ marginTop: 12 }}>{err}</div> : null}

      {busy && !data ? (
        <div className="row" style={{ marginTop: 16, alignItems: 'center', gap: 8 }}>
          <span className="spin" /><span className="hint" style={{ margin: 0 }}>Loading {layer} rows…</span>
        </div>
      ) : null}

      {/* Not materialized yet — a calm, honest state, not a raw query error. */}
      {data && !data.available ? (
        <p className="hint" style={{ marginTop: 14 }}>{data.reason ?? 'Nothing to preview yet.'}</p>
      ) : null}

      {data && data.available ? (
        rows.length === 0 ? (
          <p className="hint" style={{ marginTop: 14 }}>This {data.layer} version is materialized but holds no rows yet.</p>
        ) : (
          <>
            <div className="section-title" style={{ marginTop: 16 }}>
              Rows<span className="count-pill ok">first {rows.length}</span><span className="count-pill">{data.layer}</span>
            </div>
            <div className="table-wrap" style={{ marginTop: 8 }}>
              <table>
                <thead><tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i}>{r.map((cell, j) => <td key={j}>{cell}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
            {data.fqn ? <p className="hint mono" style={{ marginTop: 8, fontSize: 12 }}>{data.fqn}</p> : null}
          </>
        )
      ) : null}
    </div>
  );
}
