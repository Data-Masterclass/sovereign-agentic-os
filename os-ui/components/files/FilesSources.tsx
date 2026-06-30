/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useState } from 'react';

type Template = { provider: 'google-drive' | 'onedrive'; label: string; detail: string; capability: string; scopes: string[] };
type Source = {
  id: string; provider: string; label: string; scope: string; target: string; mode: string;
  domain: string; landingSensitivity: string; initialDone: boolean; cursor: string | null;
};
type SyncResult = { cadence: string; clientMode: string; added: number; updated: number; unchanged: number };

const SENS = ['public', 'internal', 'confidential', 'restricted'] as const;

export default function FilesSources({ onSynced }: { onSynced: () => void }) {
  const [sources, setSources] = useState<Source[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [err, setErr] = useState('');
  const [results, setResults] = useState<Record<string, SyncResult>>({});
  const [busy, setBusy] = useState<string | null>(null);

  // connect form
  const [draft, setDraft] = useState<{ provider: Template['provider']; scope: 'folder' | 'drive'; label: string; target: string; mode: 'copy' | 'reference'; landingSensitivity: string } | null>(null);

  const load = useCallback(async () => {
    setErr('');
    try {
      const res = await fetch('/api/files/connectors', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) { setErr(data.error ?? 'Failed to load sources'); return; }
      setSources(data.sources ?? []);
      setTemplates(data.templates ?? []);
    } catch (e) { setErr((e as Error).message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const connect = useCallback(async () => {
    if (!draft) return;
    setErr('');
    const res = await fetch('/api/files/connectors', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(draft),
    });
    const data = await res.json();
    if (!res.ok) { setErr(data.error ?? 'Could not connect'); return; }
    setDraft(null); load();
  }, [draft, load]);

  const sync = useCallback(async (idv: string) => {
    setBusy(idv); setErr('');
    try {
      const res = await fetch(`/api/files/connectors/${idv}/sync`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) { setErr(data.error ?? 'Sync failed'); return; }
      setResults((r) => ({ ...r, [idv]: data }));
      load(); onSynced();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  }, [load, onSynced]);

  const disconnect = useCallback(async (idv: string) => {
    await fetch(`/api/files/connectors/${idv}`, { method: 'DELETE' });
    load();
  }, [load]);

  return (
    <div style={{ maxWidth: 760 }}>
      <p className="lead" style={{ marginTop: 0 }}>
        Connect <strong>Google Drive</strong> or <strong>OneDrive</strong> and add a folder or the whole
        drive. Files sync into your governed store and index automatically — the first pass runs overnight,
        then changes flow in incrementally. Permissions follow <em>your</em> tiers, not the source.
      </p>

      {err ? <div className="error">{err}</div> : null}

      <div className="section-title">Connect a source</div>
      <div className="file-grid">
        {templates.map((t) => (
          <button key={t.provider} className="file-card" onClick={() => setDraft({ provider: t.provider, scope: 'folder', label: '', target: '', mode: 'copy', landingSensitivity: 'internal' })}>
            <div className="file-card-top"><span className="file-name">{t.label}</span><span className="badge ok">{t.capability}</span></div>
            <span className="file-sub">{t.detail}</span>
          </button>
        ))}
      </div>

      {draft ? (
        <div className="files-preview" style={{ marginTop: 16, maxWidth: 520 }}>
          <div className="preview-title">Connect {draft.provider === 'google-drive' ? 'Google Drive' : 'OneDrive'}</div>
          <label className="rail-group-title">What to add</label>
          <div className="files-scope">
            <button className={draft.scope === 'folder' ? 'on' : ''} onClick={() => setDraft({ ...draft, scope: 'folder' })}>A folder</button>
            <button className={draft.scope === 'drive' ? 'on' : ''} onClick={() => setDraft({ ...draft, scope: 'drive' })}>Whole drive</button>
          </div>
          <input placeholder="Label (e.g. Planning)" value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
          {draft.scope === 'folder' ? <input placeholder="Folder id / path" value={draft.target} onChange={(e) => setDraft({ ...draft, target: e.target.value })} /> : null}
          <label className="rail-group-title">Storage</label>
          <div className="files-scope">
            <button className={draft.mode === 'copy' ? 'on' : ''} onClick={() => setDraft({ ...draft, mode: 'copy' })} title="Sync bytes into the sovereign store">Copy in</button>
            <button className={draft.mode === 'reference' ? 'on' : ''} onClick={() => setDraft({ ...draft, mode: 'reference' })} title="Leave files in the drive; index references">Index in place</button>
          </div>
          <div className="preview-row">
            <select value={draft.landingSensitivity} onChange={(e) => setDraft({ ...draft, landingSensitivity: e.target.value })}>
              {SENS.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <button className="btn" onClick={connect}>Connect</button>
            <button className="btn ghost" onClick={() => setDraft(null)}>Cancel</button>
          </div>
        </div>
      ) : null}

      <div className="section-title" style={{ marginTop: 24 }}>Connected sources<span className="count-pill">{sources.length}</span></div>
      {sources.length === 0 ? <div className="stub-page">No connected drives yet.</div> : (
        <div style={{ display: 'grid', gap: 10 }}>
          {sources.map((s) => {
            const r = results[s.id];
            return (
              <div className="result" key={s.id}>
                <div className="result-head">
                  <h4>{s.label} <span className="file-sub">· {s.provider} · {s.scope} · {s.mode === 'copy' ? 'copied in' : 'in place'}</span></h4>
                  <span className="score">{s.initialDone ? 'synced' : 'never synced'}</span>
                </div>
                <div className="preview-row" style={{ marginTop: 6 }}>
                  <button className="btn ghost sm" disabled={busy === s.id} onClick={() => sync(s.id)}>
                    {busy === s.id ? <span className="spin" /> : s.initialDone ? 'Sync now (incremental)' : 'Run first sync (overnight)'}
                  </button>
                  <button className="btn ghost sm" style={{ color: 'var(--danger)' }} onClick={() => disconnect(s.id)}>Disconnect</button>
                  {r ? <span className="hint" style={{ margin: 0 }}>✓ {r.cadence} · {r.clientMode} · +{r.added} added, {r.updated} updated, {r.unchanged} unchanged</span> : null}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
