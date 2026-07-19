/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useState } from 'react';

type Grid = { columns: string[]; rows: string[][] };
type Stage = { layer: string; built: boolean };

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
  const [landed, setLanded] = useState<Stage[] | null>(null); // Bronze committed server-side
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const MAX_BYTES = 100 * 1024 * 1024; // keep in step with UPLOAD_MAX_BYTES (M1 cap)

  // upload — stream the raw file to MinIO → data-runner → physical Iceberg Bronze.
  // The server lights the Bronze dot ONLY after the ingest verify passes.
  const onFile = useCallback(async (file: File) => {
    setErr(''); setBusy(true); setPreview(null); setLanded(null);
    try {
      if (file.size > MAX_BYTES) { setErr('That file is over the 100 MB upload limit for now.'); return; }
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(`/api/data/datasets/${datasetId}/ingest`, { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok || !data.ok) { setErr(data.error ?? 'Upload failed'); return; }
      const r = data.report;
      setPreview({ columns: r.preview?.columns ?? [], rows: (r.preview?.rows ?? []).slice(0, 20) });
      setPreviewNote(
        `${r.rowCount} row${r.rowCount === 1 ? '' : 's'} landed in ${r.table}` +
        (r.mode === 'offline-mock' ? ' (offline preview — no cluster reachable).' : ' — Bronze is live.'),
      );
      setLanded((data.stages ?? []) as Stage[]);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }, [datasetId, MAX_BYTES]);

  // pull extract through Trino (masked)
  const [sql, setSql] = useState('select order_date, region, net_amount from daily_revenue order by 1');
  const [extractId, setExtractId] = useState('');
  const pull = useCallback(async () => {
    setErr(''); setBusy(true); setPreview(null); setExtractId('');
    try {
      const res = await fetch('/api/data/sandbox', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'pull-extract', name: datasetName, sql }),
      });
      const data = await res.json();
      if (!res.ok) { setErr(data.error ?? 'Pull failed'); return; }
      setPreview({ columns: data.columns ?? [], rows: (data.rows ?? []).slice(0, 20) });
      setExtractId(data.dataset?.id ?? '');
      setPreviewNote(`Masked extract pulled through Trino${data.policy ? ` (${data.policy}${data.traced ? ', traced' : ''})` : ''}.`);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }, [sql, datasetName]);

  // commit -> LAND the pulled extract as the REAL personal Bronze table (the same
  // ingest pipeline + verify-then-dot contract as the file upload). The old path
  // posted a bare {layer:'bronze'} registry write — a lit dot with no table.
  const [committing, setCommitting] = useState(false);
  const commit = useCallback(async () => {
    setErr(''); setCommitting(true);
    try {
      const res = await fetch('/api/data/sandbox', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'land-bronze', id: extractId, datasetId }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) { setErr(data.error ?? 'Could not land Bronze — nothing was registered'); return; }
      onCommitted(data.stages ?? []);
    } catch (e) { setErr((e as Error).message); } finally { setCommitting(false); }
  }, [datasetId, extractId, onCommitted]);

  return (
    <div className="guided-panel">
      <p className="muted" style={{ marginTop: 0 }}>
        Bring your data in exactly as it is. Upload a file, or pull a slice of a governed
        product — it arrives already masked to what you’re allowed to see.
      </p>

      <div className="seg">
        <button className={source === 'upload' ? 'on' : ''} onClick={() => { setSource('upload'); setPreview(null); setLanded(null); }}>Upload a file</button>
        <button className={source === 'extract' ? 'on' : ''} onClick={() => { setSource('extract'); setPreview(null); setLanded(null); }}>Pull from a product</button>
      </div>

      {source === 'upload' ? (
        <div className="row" style={{ marginTop: 12 }}>
          <input type="file" accept=".csv,.tsv,.txt,.parquet,.json,.ndjson" disabled={busy}
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
          <div className="section-title" style={{ marginTop: 0 }}>
            Preview<span className={`count-pill ok`}>{landed ? 'landed · verified' : 'before commit'}</span>
          </div>
          {previewNote ? <p className="hint" style={{ marginTop: 0 }}>{previewNote}</p> : null}
          <div className="table-wrap">
            <table>
              <thead><tr>{preview.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
              <tbody>{preview.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
            </table>
          </div>
          <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end', gap: 8 }}>
            {landed ? (
              // Upload already landed + verified server-side (Bronze dot lit). Continue
              // just refreshes the stepper — there is nothing left to confirm.
              <button className="btn" onClick={() => onCommitted(landed)}>Continue</button>
            ) : (
              <>
                <button className="btn ghost" onClick={() => { setPreview(null); setExtractId(''); }}>Discard</button>
                <button className="btn" onClick={commit} disabled={committing || !extractId}>
                  {committing ? <span className="spin" /> : 'Confirm — this is my Bronze'}
                </button>
              </>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
