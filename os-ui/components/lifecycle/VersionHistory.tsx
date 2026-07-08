/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

/**
 * VersionHistory — the ONE version panel for the whole OS. Reads the artifact's
 * `{basePath}/versions` route (every type exposes the same shape:
 * { versions: [{ version, at, author, summary }] }) and offers a per-version
 * Restore. Restore itself CONFIRMS (it changes current state) via useConfirm,
 * then POSTs { version } to the same route. Types without a versions route
 * degrade gracefully to a quiet "no version history" note.
 */

import { useCallback, useEffect, useState } from 'react';
import { useConfirm } from './ConfirmDialog';
import { restoreVersionCopy } from '@/lib/lifecycle';

type Version = { version: number; at: string; author: string; summary: string };

function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export default function VersionHistory({
  basePath,
  name,
  onRestored,
}: {
  /** API base for this artifact, e.g. `/api/dashboards/{id}` — we append `/versions`. */
  basePath: string;
  name: string;
  /** Called after a successful restore so the host can refresh its view. */
  onRestored?: () => void;
}) {
  const confirm = useConfirm();
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [err, setErr] = useState('');
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(async () => {
    setErr('');
    try {
      const res = await fetch(`${basePath}/versions`, { cache: 'no-store' });
      if (res.status === 404) {
        setUnavailable(true);
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(data.error ?? 'Could not load version history.');
        return;
      }
      setVersions(Array.isArray(data.versions) ? data.versions : []);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [basePath]);
  useEffect(() => {
    load();
  }, [load]);

  const restore = useCallback(
    async (version: number) => {
      if (!(await confirm(restoreVersionCopy(name, version)))) return;
      setBusy(version);
      setErr('');
      try {
        const res = await fetch(`${basePath}/versions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ version }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setErr(data.error ?? 'Restore failed.');
          return;
        }
        await load();
        onRestored?.();
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [confirm, name, basePath, load, onRestored],
  );

  if (unavailable) {
    return <div className="hint" style={{ marginTop: 4 }}>No version history for this item.</div>;
  }

  return (
    <div className="lc-versions">
      {err ? <div className="error" style={{ marginBottom: 10 }}>{err}</div> : null}
      {versions === null ? (
        <div className="hint">Loading history…</div>
      ) : versions.length === 0 ? (
        <div className="hint">No versions yet — the first change will start the history.</div>
      ) : (
        <ul className="lc-version-list">
          {versions.map((v, i) => (
            <li key={v.version} className="lc-version-row">
              <div className="lc-version-meta">
                <span className="lc-version-num">v{v.version}</span>
                {i === 0 ? <span className="badge muted">current</span> : null}
                <span className="muted" style={{ fontSize: 12 }}>{when(v.at)}</span>
                <span className="muted" style={{ fontSize: 12 }}>· {v.author}</span>
              </div>
              <div className="lc-version-summary">{v.summary || '—'}</div>
              {i === 0 ? null : (
                <button
                  type="button"
                  className="btn ghost sm"
                  disabled={busy !== null}
                  onClick={() => restore(v.version)}
                >
                  {busy === v.version ? <span className="spin" /> : 'Restore'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
