/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    `<HistoryDrawer/>` — the commit list, the per-commit diff, and the restore confirm
 * USER STORY: As any user I want to open my object's history, see each commit with its action,
 *             surface and actor, read the diff of any commit against the current version, and
 *             restore an older version with a confirm that says what will happen (G6, G9).
 * ARCHITECTURE:
 *   - A SHELL over `git-view.ts` (rows, footer, diff rows, the four restore states) and the
 *     `/api/git` surface. No decision and no formatting lives here.
 *   - The diff is the REAL unified diff from the repository, rendered line for line.
 *   - RESTORE IS A NEW COMMIT, NEVER A REWRITE, and the confirm says so. When the object's kind
 *     has no registered writer the button is disabled WITH the reason — the refusal is visible
 *     rather than hidden behind a missing control.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { onEscape, isBackdropClick } from '@core/kernel/overlay-dismiss';
import {
  historyRows,
  drawerFooter,
  diffRows,
  diffSummary,
  restoreView,
  type GitInfoView,
  type FileDiffView,
} from '@core/ui/git/git-view';

const ROW_COLOUR: Record<string, string> = {
  add: 'var(--ok, #1a7f37)',
  remove: 'var(--err, #b42318)',
  hunk: 'var(--muted, #6b7280)',
  file: 'var(--muted, #6b7280)',
  note: 'var(--muted, #6b7280)',
  // A binary file and a redaction are STATEMENTS about the diff, not content — shown as such.
  binary: 'var(--muted, #6b7280)',
  context: 'inherit',
};

export default function HistoryDrawer({
  kind,
  id,
  info,
  restorable,
  onClose,
  onRestored,
}: {
  kind: string;
  id: string;
  info: GitInfoView | null;
  restorable: boolean;
  onClose: () => void;
  onRestored?: () => void;
}) {
  const [selected, setSelected] = useState<string>('');
  const [diff, setDiff] = useState<{ files: FileDiffView[]; identical: boolean; redacted?: boolean } | null>(null);
  const [diffError, setDiffError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [restoreError, setRestoreError] = useState('');
  const [restored, setRestored] = useState('');

  useEffect(() => (busy ? undefined : onEscape(onClose)), [busy, onClose]);

  const rows = historyRows(info);
  const head = info?.head?.sha ?? '';

  const loadDiff = useCallback(
    async (sha: string) => {
      setSelected(sha);
      setDiff(null);
      setDiffError('');
      if (!sha || !head || sha === head) return;
      try {
        const params = new URLSearchParams({ action: 'diff', kind, id, shaA: sha, shaB: head });
        const res = await fetch(`/api/git?${params.toString()}`, { cache: 'no-store' });
        const body = await res.json();
        if (!res.ok) setDiffError(body.error ?? `Could not read the diff (${res.status})`);
        else setDiff(body as { files: FileDiffView[]; identical: boolean; redacted?: boolean });
      } catch (e) {
        setDiffError((e as Error).message);
      }
    },
    [kind, id, head],
  );

  const restore = useCallback(async () => {
    setBusy(true);
    setRestoreError('');
    try {
      const res = await fetch('/api/git', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind, id, sha: selected }),
      });
      const body = await res.json();
      if (!res.ok) setRestoreError(body.error ?? `Restore refused (${res.status})`);
      else {
        setRestored(`Restored as a new commit ${String(body.sha ?? '').slice(0, 7)}.`);
        onRestored?.();
      }
    } catch (e) {
      setRestoreError((e as Error).message);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }, [kind, id, selected, onRestored]);

  const restoreUi = restoreView({ info, sha: selected, restorable, ...(restoreError ? { error: restoreError } : {}) });

  return (
    <div className="pa-confirm-backdrop" onClick={(e) => { if (isBackdropClick(e.target, e.currentTarget) && !busy) onClose(); }}>
      <div className="pa-confirm" style={{ maxWidth: 820, textAlign: 'left' }} onClick={(e) => e.stopPropagation()}>
        <h3>
          Git history — {info?.name ?? id} <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>({kind})</span>
        </h3>
        <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>{drawerFooter(info)}</div>

        {rows.length === 0 ? (
          <div className="muted" style={{ fontSize: 13 }}>No commit touches this object yet.</div>
        ) : (
          <table className="tbl" style={{ fontSize: 12 }}>
            <thead>
              <tr>
                <th>Commit</th>
                <th>Action</th>
                <th>By</th>
                <th>From</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.sha}
                  onClick={() => void loadDiff(r.sha)}
                  style={{ cursor: 'pointer', background: selected === r.sha ? 'var(--row-sel, rgba(0,0,0,0.04))' : undefined }}
                >
                  <td className="mono" title={r.sha}>
                    {r.short}
                    {r.sha === head ? <span className="badge ok" style={{ marginLeft: 6, fontSize: 10 }}>current</span> : null}
                  </td>
                  <td>
                    {r.action}
                    {r.platform ? <span className="badge" style={{ marginLeft: 6, fontSize: 10 }} title="The OS caught the repository up — not a person's edit">OS catch-up</span> : null}
                  </td>
                  <td>{r.author}</td>
                  <td className="mono">{r.surface || '—'}</td>
                  <td title={r.at}>{r.when}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {selected && selected !== head ? (
          <div style={{ marginTop: 14 }}>
            <div className="muted" style={{ fontSize: 12 }}>
              {diffError ? diffError : diff ? diffSummary(diff.files) : 'Reading the diff against the current version …'}
            </div>
            {diff && !diff.identical ? (
              <pre
                className="mono"
                style={{ maxHeight: 280, overflow: 'auto', fontSize: 11, lineHeight: 1.45, marginTop: 8 }}
              >
                {diff.files.flatMap((f) => diffRows(f.patch)).map((row, i) => (
                  <div key={i} style={{ color: ROW_COLOUR[row.kind] ?? 'inherit' }}>{row.text || ' '}</div>
                ))}
              </pre>
            ) : null}
            <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              {restoreUi.label ? (
                <button className="btn sm" disabled={restoreUi.disabled || busy} onClick={() => setConfirming(true)}>
                  {restoreUi.label}
                </button>
              ) : null}
              <span className="muted" style={{ fontSize: 12 }}>{restored || restoreUi.note}</span>
            </div>
            {confirming && restoreUi.state === 'available' ? (
              <div className="danger-note" style={{ marginTop: 10 }}>
                {restoreUi.note} Continue?
                <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                  <button className="btn primary sm" disabled={busy} onClick={() => void restore()}>
                    {busy ? 'Restoring …' : 'Yes, restore it'}
                  </button>
                  <button className="btn ghost sm" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end' }}>
          <button className="btn ghost sm" onClick={onClose} disabled={busy}>Close</button>
        </div>
      </div>
    </div>
  );
}
