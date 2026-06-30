/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useState } from 'react';

type Grid = { columns: string[]; rows: string[][] };

/**
 * Bronze — "Bring it in." The guided face over the personal/sandbox lane: bring a
 * file or pull a masked extract THROUGH Trino into your private prefix (the existing
 * /api/data/sandbox lane — not rebuilt here), PREVIEW the raw rows, then commit it as
 * this dataset's Bronze version. Preview-before-commit, plain language; the dlt/DuckDB
 * machinery stays hidden.
 */
export default function BronzePanel({
  datasetId,
  datasetName,
  onCommitted,
}: {
  datasetId: string;
  datasetName: string;
  onCommitted: (stages: unknown[]) => void;
}) {
  const [source, setSource] = useState<'upload' | 'extract'>('upload');
  const [preview, setPreview] = useState<Grid | null>(null);
  const [previewNote, setPreviewNote] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  // upload
  const onFile = useCallback(async (file: File) => {
    setErr(''); setBusy(true); setPreview(null);
    try {
      const text = await file.text();
      const lines = text.trim().split(/\r?\n/);
      const columns = (lines.shift() ?? '').split(',').map((c) => c.trim());
      const rows = lines.map((l) => l.split(',').map((c) => c.trim()));
      const res = await fetch('/api/data/sandbox', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'upload', name: datasetName, columns, rows }),
      });
      const data = await res.json();
      if (!res.ok) { setErr(data.error ?? 'Upload failed'); return; }
      setPreview({ columns, rows: rows.slice(0, 20) });
      setPreviewNote(`${rows.length} row${rows.length === 1 ? '' : 's'} landed in your private prefix.`);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }, [datasetName]);

  // pull extract through Trino (masked)
  const [sql, setSql] = useState('select order_date, region, net_amount from daily_revenue order by 1');
  const pull = useCallback(async () => {
    setErr(''); setBusy(true); setPreview(null);
    try {
      const res = await fetch('/api/data/sandbox', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'pull-extract', name: datasetName, sql }),
      });
      const data = await res.json();
      if (!res.ok) { setErr(data.error ?? 'Pull failed'); return; }
      setPreview({ columns: data.columns ?? [], rows: (data.rows ?? []).slice(0, 20) });
      setPreviewNote(`Masked extract pulled through Trino${data.policy ? ` (${data.policy}${data.traced ? ', traced' : ''})` : ''}.`);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }, [sql, datasetName]);

  // commit -> Bronze version
  const [committing, setCommitting] = useState(false);
  const commit = useCallback(async () => {
    setErr(''); setCommitting(true);
    try {
      const res = await fetch(`/api/data/datasets/${datasetId}/version`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ layer: 'bronze', quality: 'passing' }),
      });
      const data = await res.json();
      if (!res.ok) { setErr(data.error ?? 'Could not save Bronze'); return; }
      onCommitted(data.stages ?? []);
    } catch (e) { setErr((e as Error).message); } finally { setCommitting(false); }
  }, [datasetId, onCommitted]);

  return (
    <div className="guided-panel">
      <p className="muted" style={{ marginTop: 0 }}>
        Bring your data in exactly as it is. Upload a file, or pull a slice of a governed
        product — it arrives already masked to what you’re allowed to see.
      </p>

      <div className="seg">
        <button className={source === 'upload' ? 'on' : ''} onClick={() => { setSource('upload'); setPreview(null); }}>Upload a file</button>
        <button className={source === 'extract' ? 'on' : ''} onClick={() => { setSource('extract'); setPreview(null); }}>Pull from a product</button>
      </div>

      {source === 'upload' ? (
        <div className="row" style={{ marginTop: 12 }}>
          <input type="file" accept=".csv,.tsv,.txt" disabled={busy}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }} />
          {busy ? <span className="spin" /> : null}
        </div>
      ) : (
        <div style={{ marginTop: 12 }}>
          <textarea className="mono" rows={3} value={sql} onChange={(e) => setSql(e.target.value)} spellCheck={false} />
          <div className="row" style={{ marginTop: 8, justifyContent: 'flex-end' }}>
            <button className="btn" onClick={pull} disabled={busy || !sql.trim()}>{busy ? <span className="spin" /> : 'Pull preview'}</button>
          </div>
        </div>
      )}

      {err ? <div className="error" style={{ marginTop: 12 }}>{err}</div> : null}

      {preview ? (
        <div style={{ marginTop: 16 }}>
          <div className="section-title" style={{ marginTop: 0 }}>Preview<span className="count-pill ok">before commit</span></div>
          {previewNote ? <p className="hint" style={{ marginTop: 0 }}>{previewNote}</p> : null}
          <div className="table-wrap">
            <table>
              <thead><tr>{preview.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
              <tbody>{preview.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
            </table>
          </div>
          <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end', gap: 8 }}>
            <button className="btn ghost" onClick={() => setPreview(null)}>Discard</button>
            <button className="btn" onClick={commit} disabled={committing}>
              {committing ? <span className="spin" /> : 'Confirm — this is my Bronze'}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
