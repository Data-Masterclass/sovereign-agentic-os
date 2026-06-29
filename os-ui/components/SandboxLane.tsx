/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useState } from 'react';

type Dataset = { id: string; name: string; origin: 'upload' | 'extract'; columns: string[]; rowCount: number };
type Grid = { columns: string[]; rows: string[][] };

/**
 * "My data" — the personal / sandbox lane. A single-user workbench BEHIND Trino's
 * governance: bring data (upload, or a masked pull-extract THROUGH Trino), explore
 * with an ephemeral DuckDB scoped to your private prefix, then Promote into the
 * governed lane (dbt-trino + OpenMetadata) — the only path to shared.
 */
export default function SandboxLane() {
  const [prefix, setPrefix] = useState('');
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [err, setErr] = useState('');

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/data/sandbox', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'list' }),
      });
      const data = await res.json();
      if (!res.ok) { setErr(data.error ?? 'Failed to load'); return; }
      setPrefix(data.prefix); setDatasets(data.datasets ?? []);
    } catch (e) { setErr((e as Error).message); }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  // ---- bring data: upload (CSV) ----
  const [upName, setUpName] = useState('');
  const [busyUp, setBusyUp] = useState(false);
  const onFile = useCallback(async (file: File) => {
    setErr(''); setBusyUp(true);
    try {
      const text = await file.text();
      const lines = text.trim().split(/\r?\n/);
      const columns = (lines.shift() ?? '').split(',').map((c) => c.trim());
      const rows = lines.map((l) => l.split(',').map((c) => c.trim()));
      const res = await fetch('/api/data/sandbox', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'upload', name: upName || file.name, columns, rows }),
      });
      const data = await res.json();
      if (!res.ok) setErr(data.error ?? 'Upload failed'); else { setUpName(''); refresh(); }
    } catch (e) { setErr((e as Error).message); } finally { setBusyUp(false); }
  }, [upName, refresh]);

  // ---- bring data: pull extract THROUGH Trino ----
  const [pullName, setPullName] = useState('');
  const [pullSql, setPullSql] = useState('select order_date, revenue from daily_revenue order by 1');
  const [busyPull, setBusyPull] = useState(false);
  const [pullMsg, setPullMsg] = useState('');
  const pull = useCallback(async () => {
    setErr(''); setPullMsg(''); setBusyPull(true);
    try {
      const res = await fetch('/api/data/sandbox', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'pull-extract', name: pullName || 'extract', sql: pullSql }),
      });
      const data = await res.json();
      if (!res.ok) setErr(data.error ?? 'Pull failed');
      else { setPullMsg(`✓ masked extract pulled through Trino (${data.policy}${data.traced ? ', traced' : ''})`); setPullName(''); refresh(); }
    } catch (e) { setErr((e as Error).message); } finally { setBusyPull(false); }
  }, [pullName, pullSql, refresh]);

  // ---- explore (ephemeral DuckDB over the private prefix only) ----
  const [exSql, setExSql] = useState('');
  const [grid, setGrid] = useState<Grid | null>(null);
  const [exNote, setExNote] = useState('');
  const [busyEx, setBusyEx] = useState(false);
  const explore = useCallback(async () => {
    setErr(''); setExNote(''); setGrid(null); setBusyEx(true);
    try {
      const res = await fetch('/api/data/sandbox', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'explore', sql: exSql }),
      });
      const data = await res.json();
      if (!res.ok) setErr(data.error ?? 'Explore failed');
      else { setGrid({ columns: data.columns ?? [], rows: data.rows ?? [] }); if (data.scaffolded) setExNote(data.note ?? ''); }
    } catch (e) { setErr((e as Error).message); } finally { setBusyEx(false); }
  }, [exSql]);

  // ---- promote -> governed ----
  const [promoteId, setPromoteId] = useState('');
  const [domain, setDomain] = useState('sales');
  const [visibility, setVisibility] = useState('shared');
  const [plan, setPlan] = useState<Record<string, unknown> | null>(null);
  const promote = useCallback(async () => {
    setErr(''); setPlan(null);
    try {
      const res = await fetch('/api/data/sandbox', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'promote', id: promoteId, domain, visibility }),
      });
      const data = await res.json();
      if (!res.ok) setErr(data.error ?? 'Promote failed'); else setPlan(data.plan);
    } catch (e) { setErr((e as Error).message); }
  }, [promoteId, domain, visibility]);

  return (
    <>
      <div className="section-title">
        My data <span className="badge vis-personal">Personal</span>
        {prefix ? <span className="count-pill ok">{prefix}</span> : null}
      </div>
      <p className="hint" style={{ marginTop: 0 }}>
        A private workbench behind Trino&apos;s governance. Bring your own files or pull a
        <strong> masked extract through Trino</strong>, explore with an ephemeral DuckDB scoped to
        your private prefix, then <strong>Promote</strong> into the governed lane (dbt-trino +
        OpenMetadata). DuckDB never reads governed marts directly.
      </p>

      {err ? <div className="error">{err}</div> : null}

      <div className="grid-2" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
        {/* Bring data — upload */}
        <div className="card">
          <h3>Bring data — upload</h3>
          <p className="muted" style={{ marginTop: 0 }}>CSV / Parquet / Excel → your private prefix.</p>
          <input type="text" placeholder="dataset name (optional)" value={upName} onChange={(e) => setUpName(e.target.value)} />
          <div className="row" style={{ marginTop: 10 }}>
            <input type="file" accept=".csv,.tsv,.txt" disabled={busyUp}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }} />
            {busyUp ? <span className="spin" /> : null}
          </div>
        </div>

        {/* Bring data — pull extract through Trino */}
        <div className="card">
          <h3>Bring data — pull extract <span className="badge ok">via Trino</span></h3>
          <p className="muted" style={{ marginTop: 0 }}>Runs through Trino so it arrives row/column-masked to your entitlements.</p>
          <input type="text" placeholder="extract name" value={pullName} onChange={(e) => setPullName(e.target.value)} />
          <textarea className="mono" rows={3} value={pullSql} onChange={(e) => setPullSql(e.target.value)} spellCheck={false} style={{ marginTop: 8 }} />
          <div className="row" style={{ marginTop: 10, justifyContent: 'space-between' }}>
            <div className="hint" style={{ marginTop: 0 }}>{pullMsg}</div>
            <button className="btn" onClick={pull} disabled={busyPull || !pullSql.trim()}>{busyPull ? <span className="spin" /> : 'Pull extract'}</button>
          </div>
        </div>
      </div>

      {/* Your private data */}
      <div className="section-title" style={{ marginTop: 24 }}>Your private data</div>
      {datasets.length === 0 ? (
        <div className="stub-page">No private datasets yet — upload a file or pull an extract above.</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Origin</th><th>Columns</th><th>Rows</th><th></th></tr></thead>
            <tbody>
              {datasets.map((d) => (
                <tr key={d.id}>
                  <td style={{ fontWeight: 600 }}>{d.name}</td>
                  <td><span className={`chip${d.origin === 'extract' ? '' : ''}`}>{d.origin === 'extract' ? 'Trino extract (masked)' : 'upload'}</span></td>
                  <td className="mono" style={{ fontSize: 11 }}>{d.columns.join(', ') || '—'}</td>
                  <td>{d.rowCount}</td>
                  <td><button className="btn ghost" style={{ padding: '4px 10px' }} onClick={() => setPromoteId(d.id)}>Promote →</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Explore — ephemeral DuckDB */}
      <div className="section-title" style={{ marginTop: 24 }}>Explore <span className="badge muted">ephemeral DuckDB · private prefix only</span></div>
      <textarea className="mono" rows={4} value={exSql} onChange={(e) => setExSql(e.target.value)}
        placeholder="select * from my_upload join sales_snapshot using (id)" spellCheck={false} />
      <div className="row" style={{ marginTop: 10, justifyContent: 'space-between' }}>
        <div className="hint" style={{ marginTop: 0 }}>Scoped to your uploads + masked extracts — governed marts are blocked.</div>
        <button className="btn" onClick={explore} disabled={busyEx || !exSql.trim()}>{busyEx ? <span className="spin" /> : 'Run'}</button>
      </div>
      {exNote ? <p className="hint">{exNote}</p> : null}
      {grid ? (
        <div className="table-wrap" style={{ marginTop: 12 }}>
          <table>
            <thead><tr>{grid.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
            <tbody>{grid.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
          </table>
        </div>
      ) : null}

      {/* Promote -> governed */}
      {promoteId ? (
        <>
          <div className="section-title" style={{ marginTop: 24 }}>Promote to governed</div>
          <p className="hint" style={{ marginTop: 0 }}>
            The only path from sandbox to shared: dbt-trino writes a governed Iceberg product and
            OpenMetadata catalogs it (owner / domain / visibility / lineage).
          </p>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <input type="text" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="domain" style={{ maxWidth: 180 }} />
            <select value={visibility} onChange={(e) => setVisibility(e.target.value)}>
              <option value="domain">domain</option>
              <option value="shared">shared</option>
              <option value="public">public</option>
            </select>
            <button className="btn" onClick={promote}>Promote</button>
            <button className="btn ghost" onClick={() => { setPromoteId(''); setPlan(null); }}>Cancel</button>
          </div>
          {plan ? (
            <pre className="codeblock" style={{ marginTop: 12 }}>{JSON.stringify(plan, null, 2)}</pre>
          ) : null}
        </>
      ) : null}
    </>
  );
}
