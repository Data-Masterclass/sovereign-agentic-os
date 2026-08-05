/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useState } from 'react';

type Grid = { columns: string[]; rows: string[][] };
type Stage = { layer: string; built: boolean };

/**
 * Bronze — "Bring it in." The guided face over the personal/sandbox lane: UPLOAD a
 * file THROUGH the ingest pipeline into your private prefix (the existing
 * /api/data/sandbox lane — not rebuilt here), PREVIEW the raw rows, then commit it as
 * this dataset's Bronze version. Preview-before-commit, plain language; the dlt/DuckDB
 * machinery stays hidden. Ingestion is upload-only — external lakehouse data arrives
 * governed, via a connection ("From a connection"), never a free-SQL pull here.
 */
export default function BronzePanel({
  datasetId,
  onCommitted,
}: {
  datasetId: string;
  onCommitted: (stages: unknown[]) => void;
}) {
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

  return (
    <div className="guided-panel">
      <div className="row" style={{ marginTop: 4 }}>
        <input type="file" accept=".csv,.tsv,.txt,.parquet,.json,.ndjson" disabled={busy}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }} />
        {busy ? <span className="spin" /> : null}
      </div>
      <p className="hint" style={{ marginTop: 8, marginBottom: 0 }}>
        Ingestion brings in a file you have. Data from an external lakehouse arrives
        governed, via a connection (&ldquo;From a connection&rdquo;) — not a query here.
      </p>

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
            {/* Upload already landed + verified server-side (Bronze dot lit). Continue
                just refreshes the stepper — there is nothing left to confirm. */}
            {landed ? <button className="btn" onClick={() => onCommitted(landed)}>Continue</button> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
