/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    VersionHistory — the shared version list with a per-version Restore
 * USER STORY: As an artifact owner I want to see who changed what and when, and restore an
 *             earlier version after confirming, so that I can undo a bad change.
 * ARCHITECTURE:
 *   - Reads `GET {basePath}/versions` (`{ versions: [{ version, at, author, summary }] }`) and
 *     restores with `POST {basePath}/versions { version }` after a confirmation through
 *     `useConfirm()` with `restoreVersionCopy` from `@core/kernel/lifecycle`.
 *   - A 404 means the type has no versions route, so it shows a quiet "no version history"
 *     note. Rendered by `LifecycleActions` and `tabs/software/ui/SoftwareBuilder.tsx`.
 * I18N:       converted (wave 4) — texts from `common.lifecycle.versions.*`, the confirm from the
 *             `restoreVersionCopyMessage` twin, dates through `useFormat()`, server errors via `useServerMessage()`.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { useConfirm } from '@core/ui/lifecycle/ConfirmDialog';
import { renderConfirmCopy, restoreVersionCopyMessage } from '@core/kernel/lifecycle';
import { useFormat, useServerMessage, useTranslations } from '@core/i18n/client';
import { useCommonMessage } from '@core/ui/useScopeLabel';

type Version = { version: number; at: string; author: string; summary: string };

/** The change time in the reader's format; an unparseable value is shown as sent. */
function when(iso: string, dateTime: (v: Date) => string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return dateTime(d);
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
  const t = useTranslations('common');
  const f = useFormat();
  const text = useCommonMessage();
  const serverMsg = useServerMessage();
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
        setErr(serverMsg(data, t('lifecycle.versions.loadFailed')));
        return;
      }
      setVersions(Array.isArray(data.versions) ? data.versions : []);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [basePath, serverMsg, t]);
  useEffect(() => {
    load();
  }, [load]);

  const restore = useCallback(
    async (version: number) => {
      if (!(await confirm(renderConfirmCopy(restoreVersionCopyMessage(name, version), text)))) return;
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
          setErr(serverMsg(data, t('lifecycle.versions.restoreFailed')));
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
    [confirm, name, basePath, load, onRestored, text, serverMsg, t],
  );

  if (unavailable) {
    return <div className="hint" style={{ marginTop: 4 }}>{t('lifecycle.versions.unavailable')}</div>;
  }

  return (
    <div className="lc-versions">
      {err ? <div className="error" style={{ marginBottom: 10 }}>{err}</div> : null}
      {versions === null ? (
        <div className="hint">{t('lifecycle.versions.loading')}</div>
      ) : versions.length === 0 ? (
        <div className="hint">{t('lifecycle.versions.empty')}</div>
      ) : (
        <ul className="lc-version-list">
          {versions.map((v, i) => (
            <li key={v.version} className="lc-version-row">
              <div className="lc-version-meta">
                <span className="lc-version-num">{t('lifecycle.versions.number', { version: String(v.version) })}</span>
                {i === 0 ? <span className="badge muted">{t('lifecycle.versions.current')}</span> : null}
                <span className="muted" style={{ fontSize: 12 }}>{when(v.at, (d) => f.dateTime(d))}</span>
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
                  {busy === v.version ? <span className="spin" /> : t('lifecycle.versions.restore')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
