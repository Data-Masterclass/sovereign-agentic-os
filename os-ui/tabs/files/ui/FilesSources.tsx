/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations, useServerMessage } from '@core/i18n/client';

type Template = { provider: 'google-drive' | 'onedrive'; label: string; detail: string; capability: string; scopes: string[] };
type Source = {
  id: string; provider: string; label: string; scope: string; target: string; mode: string;
  domain: string; landingSensitivity: string; initialDone: boolean; cursor: string | null;
  paused?: { reason: string; at: string } | null;
};
type DriveConnection = { id: string; name: string; provider: Template['provider'] };
type SyncResult = { cadence: string; clientMode: string; added: number; updated: number; unchanged: number };

const SENS = ['public', 'internal', 'confidential', 'restricted'] as const;
/** The provider's product name — a brand, never translated. */
const providerName = (p: Template['provider']) => (p === 'google-drive' ? 'Google Drive' : 'OneDrive');

export default function FilesSources({ onSynced }: { onSynced: () => void }) {
  const t = useTranslations('files');
  const msg = useServerMessage();
  const tc = useTranslations('common');
  const [sources, setSources] = useState<Source[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [connections, setConnections] = useState<DriveConnection[]>([]);
  const [err, setErr] = useState('');
  const [results, setResults] = useState<Record<string, SyncResult>>({});
  const [busy, setBusy] = useState<string | null>(null);

  // connect form
  const [draft, setDraft] = useState<{ provider: Template['provider']; scope: 'folder' | 'drive'; label: string; target: string; mode: 'copy' | 'reference'; landingSensitivity: string; connectionId: string } | null>(null);

  const load = useCallback(async () => {
    setErr('');
    try {
      const res = await fetch('/api/files/connectors', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) { setErr(msg(data, t('sources.loadFailed'))); return; }
      setSources(data.sources ?? []);
      setTemplates(data.templates ?? []);
      setConnections(data.connections ?? []);
    } catch (e) { setErr((e as Error).message); }
  }, [t]);
  useEffect(() => { load(); }, [load]);

  const connect = useCallback(async () => {
    if (!draft) return;
    setErr('');
    const res = await fetch('/api/files/connectors', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(draft),
    });
    const data = await res.json();
    if (!res.ok) { setErr(msg(data, t('sources.connectFailed'))); return; }
    setDraft(null); load();
  }, [draft, load, t]);

  const sync = useCallback(async (idv: string) => {
    setBusy(idv); setErr('');
    try {
      const res = await fetch(`/api/files/connectors/${idv}/sync`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) { setErr(msg(data, t('sources.syncFailed'))); return; }
      setResults((r) => ({ ...r, [idv]: data }));
      load(); onSynced();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  }, [load, onSynced, t]);

  const disconnect = useCallback(async (idv: string) => {
    await fetch(`/api/files/connectors/${idv}`, { method: 'DELETE' });
    load();
  }, [load]);

  return (
    <div style={{ maxWidth: 760 }}>
      {err ? <div className="error">{err}</div> : null}

      <div className="section-title">{t('sources.connectTitle')}</div>
      <div className="file-grid">
        {templates.map((tpl) => (
          <button key={tpl.provider} className="file-card" onClick={() => setDraft({ provider: tpl.provider, scope: 'folder', label: '', target: '', mode: 'copy', landingSensitivity: 'internal', connectionId: connections.find((c) => c.provider === tpl.provider)?.id ?? '' })}>
            <div className="file-card-top"><span className="file-name">{tpl.label}</span><span className="badge ok">{tpl.capability}</span></div>
            <span className="file-sub">{tpl.detail}</span>
          </button>
        ))}
      </div>

      {draft ? (
        <div className="files-preview" style={{ marginTop: 16, maxWidth: 520 }}>
          <div className="preview-title">{t('sources.connectProvider', { provider: providerName(draft.provider) })}</div>
          <label className="rail-group-title">{t('sources.connection')}</label>
          {connections.some((c) => c.provider === draft.provider) ? (
            <select value={draft.connectionId} onChange={(e) => setDraft({ ...draft, connectionId: e.target.value })}>
              {connections.filter((c) => c.provider === draft.provider).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          ) : (
            <span className="hint">{t('sources.noConnection', { provider: providerName(draft.provider) })}</span>
          )}
          <label className="rail-group-title">{t('sources.whatToAdd')}</label>
          <div className="files-scope">
            <button className={draft.scope === 'folder' ? 'on' : ''} onClick={() => setDraft({ ...draft, scope: 'folder' })}>{t('sources.aFolder')}</button>
            <button className={draft.scope === 'drive' ? 'on' : ''} onClick={() => setDraft({ ...draft, scope: 'drive' })}>{t('sources.wholeDrive')}</button>
          </div>
          <input placeholder={t('sources.labelPlaceholder')} value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
          {draft.scope === 'folder' ? <input placeholder={t('sources.targetPlaceholder')} value={draft.target} onChange={(e) => setDraft({ ...draft, target: e.target.value })} /> : null}
          <label className="rail-group-title">{t('sources.storage')}</label>
          <div className="files-scope">
            <button className={draft.mode === 'copy' ? 'on' : ''} onClick={() => setDraft({ ...draft, mode: 'copy' })} title={t('sources.copyTitle')}>{t('sources.copy')}</button>
            <button className={draft.mode === 'reference' ? 'on' : ''} onClick={() => setDraft({ ...draft, mode: 'reference' })} title={t('sources.referenceTitle')}>{t('sources.reference')}</button>
          </div>
          <div className="preview-row">
            <select value={draft.landingSensitivity} onChange={(e) => setDraft({ ...draft, landingSensitivity: e.target.value })}>
              {SENS.map((s) => <option key={s} value={s}>{t(`sensitivity.${s}`)}</option>)}
            </select>
            <button className="btn" onClick={connect}>{t('sources.connect')}</button>
            <button className="btn ghost" onClick={() => setDraft(null)}>{tc('actions.cancel')}</button>
          </div>
        </div>
      ) : null}

      <div className="section-title" style={{ marginTop: 24 }}>{t('sources.connected')}<span className="count-pill">{sources.length}</span></div>
      {sources.length === 0 ? <div className="stub-page">{t('sources.none')}</div> : (
        <div style={{ display: 'grid', gap: 10 }}>
          {sources.map((s) => {
            const r = results[s.id];
            return (
              <div className="result" key={s.id}>
                <div className="result-head">
                  <h4>{s.label} <span className="file-sub">· {s.provider} · {s.scope === 'folder' ? t('sources.scopeFolder') : s.scope === 'drive' ? t('sources.scopeDrive') : s.scope} · {s.mode === 'copy' ? t('sources.copiedIn') : t('sources.inPlace')}</span></h4>
                  <span className="score">{s.paused ? t('sources.paused') : s.initialDone ? t('sources.synced') : t('sources.neverSynced')}</span>
                </div>
                {s.paused ? <div className="hint" style={{ marginTop: 4 }}>{t('sources.pausedReason', { reason: s.paused.reason })}</div> : null}
                <div className="preview-row" style={{ marginTop: 6 }}>
                  <button className="btn ghost sm" disabled={busy === s.id} onClick={() => sync(s.id)}>
                    {busy === s.id ? <span className="spin" /> : s.initialDone ? t('sources.syncNow') : t('sources.firstSync')}
                  </button>
                  <button className="btn ghost sm" style={{ color: 'var(--danger)' }} onClick={() => disconnect(s.id)}>{t('sources.disconnect')}</button>
                  {r ? <span className="hint" style={{ margin: 0 }}>{t('sources.result', { cadence: r.cadence, clientMode: r.clientMode, added: r.added, updated: r.updated, unchanged: r.unchanged })}</span> : null}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
