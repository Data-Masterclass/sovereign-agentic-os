/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    DatasetVersions — the dataset's data versions, which are its Iceberg snapshots (WP-37)
 * USER STORY: As a data owner I want to see each version of my data, restore one after confirming,
 *             and pin one by name, so that I can undo a bad build and keep a known-good state.
 * ARCHITECTURE:
 *   - Reads `GET /api/data/datasets/{id}/versions` (the table's `$snapshots` and `$refs`, read as me).
 *   - Restore and name: `POST … { action: 'restore' | 'tag', snapshotId, name }`.
 *   - A refusal (`shared_table`, `legacy_lane`, `not_built`) is shown verbatim: it says why.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { useConfirm } from '@core/ui/lifecycle/ConfirmDialog';

type Version = {
  snapshotId: string; committedAt: string; operation: string; addedRecords: string | null;
  totalRecords: string | null; trinoUser: string | null; current: boolean;
  refs: { name: string; type: 'TAG' | 'BRANCH' }[];
};
type Payload = { table: string; layer: string; versions: Version[]; legacyLane: boolean; error?: string };

const when = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
};

export default function DatasetVersions({ datasetId, name, canEdit, onRestored }: {
  datasetId: string; name: string; canEdit: boolean; onRestored?: () => void;
}) {
  const confirm = useConfirm();
  const api = `/api/data/datasets/${datasetId}/versions`;
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr('');
    const res = await fetch(api, { cache: 'no-store' }).catch((e: Error) => ({ ok: false, json: async () => ({ error: e.message }) }) as Response);
    const body = (await res.json().catch(() => ({}))) as Payload;
    if (!res.ok) { setErr(body.error ?? 'Could not load versions.'); setData(null); return; }
    setData(body);
  }, [api]);
  useEffect(() => { void load(); }, [load]);

  const post = useCallback(async (payload: Record<string, unknown>, key: string) => {
    setBusy(key);
    setErr('');
    try {
      const res = await fetch(api, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(body.error ?? 'The change was refused.'); return false; }
      await load();
      return true;
    } finally {
      setBusy(null);
    }
  }, [api, load]);

  const restore = async (v: Version) => {
    const ok = await confirm({
      title: `Restore “${name}” to this version?`,
      body: `The table will read snapshot ${v.snapshotId} (${when(v.committedAt)}) again. Newer versions stay in the history, so you can roll forward later.`,
      confirmLabel: 'Restore',
      danger: false,
    });
    if (ok && (await post({ action: 'restore', snapshotId: v.snapshotId }, v.snapshotId))) onRestored?.();
  };
  const tag = async (v: Version) => {
    const label = window.prompt('Name this version (letters, digits, . _ -). A named version is never expired.');
    if (label) await post({ action: 'tag', snapshotId: v.snapshotId, name: label.trim() }, v.snapshotId);
  };

  if (err && !data) return <div className="hint" style={{ marginTop: 4 }}>{err}</div>;
  if (!data) return <div className="hint">Loading versions…</div>;
  return (
    <div className="lc-versions">
      <div className="hint" style={{ marginBottom: 8 }}>
        Versions of <span className="mono">{data.table}</span> ({data.layer}), read from Iceberg.
        {data.legacyLane ? ' This table predates per-dataset lane names, so it is read-only here.' : ''}
      </div>
      {err ? <div className="error" style={{ marginBottom: 10 }}>{err}</div> : null}
      {data.versions.length === 0 ? <div className="hint">No versions yet.</div> : (
        <ul className="lc-version-list">
          {data.versions.map((v) => (
            <li key={v.snapshotId} className="lc-version-row">
              <div className="lc-version-meta">
                <span className="lc-version-num mono" title={v.snapshotId}>{v.snapshotId.slice(-8)}</span>
                {v.current ? <span className="badge muted">current</span> : null}
                {v.refs.map((r) => <span key={r.name} className="badge">{r.type === 'TAG' ? '🏷' : '⑂'} {r.name}</span>)}
                <span className="muted" style={{ fontSize: 12 }}>{when(v.committedAt)}</span>
                {v.trinoUser ? <span className="muted" style={{ fontSize: 12 }}>· {v.trinoUser}</span> : null}
              </div>
              <div className="lc-version-summary">{v.operation}{v.totalRecords ? ` · ${v.totalRecords} rows` : ''}</div>
              {canEdit && !data.legacyLane ? (
                <span className="row" style={{ gap: 6 }}>
                  {v.current ? null : (
                    <button type="button" className="btn ghost sm" disabled={busy !== null} onClick={() => restore(v)}>
                      {busy === v.snapshotId ? <span className="spin" /> : 'Restore'}
                    </button>
                  )}
                  <button type="button" className="btn ghost sm" disabled={busy !== null} onClick={() => tag(v)}>Name</button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
