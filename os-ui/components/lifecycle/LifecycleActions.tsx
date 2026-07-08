/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

/**
 * LifecycleActions — the ONE control cluster used on every artifact card + detail:
 *   Archive (or Restore when archived) · Delete · Version history
 * Same placement, same style, same confirm copy everywhere. It takes the
 * artifact's identity + a callbacks bag, drives <ConfirmDialog> for archive
 * (light) and delete (strong, name-gated for shared/certified), and toggles the
 * shared <VersionHistory> popover.
 *
 * Two ways to wire it, whichever the host tab already has:
 *   • `api` — the artifact's API base (e.g. `/api/files/{id}`). We POST
 *     {action:'archive'|'unarchive'}, DELETE, and read `${api}/versions`.
 *   • `handlers` — explicit onArchive/onRestore/onDelete callbacks (for tabs
 *     whose store calls differ). Provide one or the other.
 * The parent stays the owner of "did it succeed" via onChanged() (re-fetch).
 */

import { useCallback, useState } from 'react';
import { useConfirm } from './ConfirmDialog';
import VersionHistory from './VersionHistory';
import { archiveCopy, deleteCopy, type ArtifactKind, type Visibility } from '@/lib/lifecycle';

type Handlers = {
  onArchive?: () => Promise<void> | void;
  onRestore?: () => Promise<void> | void;
  onDelete?: () => Promise<void> | void;
};

export default function LifecycleActions({
  id,
  name,
  kind,
  visibility,
  archived,
  api,
  handlers,
  onChanged,
  compact = false,
  showVersions = true,
}: {
  id: string;
  name: string;
  kind: ArtifactKind;
  visibility: Visibility;
  archived: boolean;
  /** API base like `/api/files/{id}`. Used if `handlers` are not supplied. */
  api?: string;
  handlers?: Handlers;
  /** Re-fetch hook — called after a successful archive/restore/delete. */
  onChanged?: () => void;
  /** `sm` buttons for cards; regular for detail headers. */
  compact?: boolean;
  /** Whether this artifact kind has a versions route. */
  showVersions?: boolean;
}) {
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const sm = compact ? ' sm' : '';

  // Run an action (callback if given, else the standard API call), then refresh.
  const run = useCallback(
    async (kindOf: 'archive' | 'unarchive' | 'delete', override?: () => Promise<void> | void) => {
      setBusy(true);
      try {
        if (override) {
          await override();
        } else if (api) {
          const res =
            kindOf === 'delete'
              ? await fetch(api, { method: 'DELETE' })
              : await fetch(api, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ action: kindOf }),
                });
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error ?? 'Action failed');
          }
        }
        onChanged?.();
      } finally {
        setBusy(false);
      }
    },
    [api, onChanged],
  );

  const doArchive = useCallback(async () => {
    if (!(await confirm(archiveCopy(name)))) return;
    await run('archive', handlers?.onArchive);
  }, [confirm, name, run, handlers]);

  const doRestore = useCallback(async () => {
    // Un-archiving is low-stakes and reversible → no confirm needed.
    await run('unarchive', handlers?.onRestore);
  }, [run, handlers]);

  const doDelete = useCallback(async () => {
    if (!(await confirm(deleteCopy(kind, name, visibility)))) return;
    await run('delete', handlers?.onDelete);
  }, [confirm, kind, name, visibility, run, handlers]);

  return (
    <>
      <div className="lc-actions row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {archived ? (
          <button type="button" className={`btn ghost${sm}`} disabled={busy} onClick={doRestore}>
            {busy ? <span className="spin" /> : 'Restore'}
          </button>
        ) : (
          <button
            type="button"
            className={`btn ghost${sm}`}
            disabled={busy}
            onClick={doArchive}
            title="Archive hides it from lists (reversible)"
          >
            {busy ? <span className="spin" /> : 'Archive'}
          </button>
        )}
        <button
          type="button"
          className={`btn ghost${sm} lc-delete`}
          disabled={busy}
          onClick={doDelete}
          title="Delete permanently — removes the backing resource"
        >
          Delete
        </button>
        {showVersions && api ? (
          <button
            type="button"
            className={`btn ghost${sm}${showHistory ? ' on' : ''}`}
            onClick={() => setShowHistory((v) => !v)}
            aria-expanded={showHistory}
          >
            {showHistory ? 'Hide history' : 'Version history'}
          </button>
        ) : null}
      </div>
      {showHistory && api ? (
        <div className="lc-history-panel">
          <VersionHistory basePath={api} name={name} onRestored={onChanged} />
        </div>
      ) : null}
    </>
  );
}
