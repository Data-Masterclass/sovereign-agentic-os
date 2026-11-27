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
import { useTranslations, useFormat, useServerMessage } from '@core/i18n/client';
import type { Formatters } from '@core/i18n/format';

type Version = {
  snapshotId: string; committedAt: string; operation: string; addedRecords: string | null;
  totalRecords: string | null; trinoUser: string | null; current: boolean;
  refs: { name: string; type: 'TAG' | 'BRANCH' }[];
};
type Payload = { table: string; layer: string; versions: Version[]; legacyLane: boolean; error?: string };

/** The full numeric date + time `toLocaleString()` gave (en: "11/27/2026, 10:30:00 AM"), in the user's locale. */
const FULL_DATE_TIME: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' };
const when = (iso: string, f: Formatters) => f.dateTime(iso, FULL_DATE_TIME) || iso;

export default function DatasetVersions({ datasetId, name, canEdit, onRestored }: {
  datasetId: string; name: string; canEdit: boolean; onRestored?: () => void;
}) {
  const confirm = useConfirm();
  const t = useTranslations('data');
  const serverMsg = useServerMessage();
  const f = useFormat();
  const api = `/api/data/datasets/${datasetId}/versions`;
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [legacy, setLegacy] = useState<{ available: boolean; reason?: string; versions: { version: number; at: string; author: string; summary: string }[] } | null>(null);
  const [showLegacy, setShowLegacy] = useState(false);
  useEffect(() => {
    if (!showLegacy || legacy) return;
    void fetch(`${api}?view=legacy`, { cache: 'no-store' }).then((r) => r.json()).then(setLegacy).catch((e: Error) => setLegacy({ available: false, reason: e.message, versions: [] }));
  }, [showLegacy, legacy, api]);

  const load = useCallback(async () => {
    setErr('');
    const res = await fetch(api, { cache: 'no-store' }).catch((e: Error) => ({ ok: false, json: async () => ({ error: e.message }) }) as Response);
    const body = (await res.json().catch(() => ({}))) as Payload;
    if (!res.ok) { setErr(serverMsg(body, t('versions.loadFailed'))); setData(null); return; }
    setData(body);
  }, [api, t]);
  useEffect(() => { void load(); }, [load]);

  const post = useCallback(async (payload: Record<string, unknown>, key: string) => {
    setBusy(key);
    setErr('');
    try {
      const res = await fetch(api, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(serverMsg(body, t('versions.refused'))); return false; }
      await load();
      return true;
    } finally {
      setBusy(null);
    }
  }, [api, load, t]);

  const restore = async (v: Version) => {
    const ok = await confirm({
      title: t('versions.restoreTitle', { name }),
      body: t('versions.restoreBody', { snapshot: v.snapshotId, date: when(v.committedAt, f) }),
      confirmLabel: t('versions.restore'),
      danger: false,
    });
    if (ok && (await post({ action: 'restore', snapshotId: v.snapshotId }, v.snapshotId))) onRestored?.();
  };
  const tag = async (v: Version) => {
    const label = window.prompt(t('versions.namePrompt'));
    if (label) await post({ action: 'tag', snapshotId: v.snapshotId, name: label.trim() }, v.snapshotId);
  };

  if (err && !data) return <div className="hint" style={{ marginTop: 4 }}>{err}</div>;
  if (!data) return <div className="hint">{t('versions.loading')}</div>;
  return (
    <div className="lc-versions">
      <div className="hint" style={{ marginBottom: 8 }}>
        {t.rich(data.legacyLane ? 'versions.introLegacy' : 'versions.intro', { table: data.table, layer: data.layer, mono: (c) => <span className="mono">{c}</span> })}
      </div>
      {err ? <div className="error" style={{ marginBottom: 10 }}>{err}</div> : null}
      {data.versions.length === 0 ? <div className="hint">{t('versions.none')}</div> : (
        <ul className="lc-version-list">
          {data.versions.map((v) => (
            <li key={v.snapshotId} className="lc-version-row">
              <div className="lc-version-meta">
                <span className="lc-version-num mono" title={v.snapshotId}>{v.snapshotId.slice(-8)}</span>
                {v.current ? <span className="badge muted">{t('versions.current')}</span> : null}
                {v.refs.map((r) => <span key={r.name} className="badge">{r.type === 'TAG' ? '🏷' : '⑂'} {r.name}</span>)}
                <span className="muted" style={{ fontSize: 12 }}>{when(v.committedAt, f)}</span>
                {v.trinoUser ? <span className="muted" style={{ fontSize: 12 }}>· {v.trinoUser}</span> : null}
              </div>
              <div className="lc-version-summary">{v.totalRecords && Number.isFinite(Number(v.totalRecords)) ? t('versions.summaryRows', { operation: v.operation, count: Number(v.totalRecords) }) : v.operation}</div>
              {canEdit && !data.legacyLane ? (
                <span className="row" style={{ gap: 6 }}>
                  {v.current ? null : (
                    <button type="button" className="btn ghost sm" disabled={busy !== null} onClick={() => restore(v)}>
                      {busy === v.snapshotId ? <span className="spin" /> : t('versions.restore')}
                    </button>
                  )}
                  <button type="button" className="btn ghost sm" disabled={busy !== null} onClick={() => tag(v)}>{t('versions.name')}</button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="btn ghost sm" style={{ marginTop: 8 }} onClick={() => setShowLegacy((v) => !v)} aria-expanded={showLegacy}>
        {showLegacy ? t('versions.hideLegacy') : t('versions.showLegacy')}
      </button>
      {showLegacy ? (
        !legacy ? <div className="hint">{t('versions.loadingShort')}</div>
          : !legacy.available ? <div className="hint">{legacy.reason}</div>
          : legacy.versions.length === 0 ? <div className="hint">{t('versions.noLegacy')}</div>
          : (
            <ul className="lc-version-list">
              {legacy.versions.map((v) => (
                <li key={v.version} className="lc-version-row">
                  <div className="lc-version-meta">
                    <span className="lc-version-num">{t('versions.legacyVersion', { version: v.version })}</span>
                    <span className="muted" style={{ fontSize: 12 }}>{when(v.at, f)} · {v.author}</span>
                  </div>
                  <div className="lc-version-summary">{v.summary || '—'}</div>
                </li>
              ))}
            </ul>
          )
      ) : null}
    </div>
  );
}
