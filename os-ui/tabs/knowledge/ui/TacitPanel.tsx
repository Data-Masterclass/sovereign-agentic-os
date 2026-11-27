/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations, useServerMessage } from '@core/i18n/client';

/**
 * Tacit-knowledge panel — the workflow-level tacit doc (sibling tacit.md). Capture
 * the practitioners' hidden know-how by pasting notes or uploading a transcript.
 * The captured source lands in the editor; Save commits it to tacit.md.
 * Voice recording is not available yet: the former "Record (stub)" button only
 * inserted canned text, so it is not rendered until real transcription exists.
 */

export default function TacitPanel({
  workflowId,
  initialTacit,
  canEdit,
}: {
  workflowId: string;
  initialTacit: string;
  canEdit: boolean;
}) {
  const t = useTranslations('knowledge');
  const serverMsg = useServerMessage();
  const [tacit, setTacit] = useState(initialTacit);
  const [raw, setRaw] = useState(''); // the captured-but-not-yet-compressed source
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const fileRef = useRef<HTMLInputElement | null>(null);

  // Refresh from the server on mount so re-entering the tab shows the latest
  // saved tacit.md (this panel saves independently of the parent reload).
  useEffect(() => {
    let live = true;
    fetch(`/api/knowledge/workflows/${workflowId}/tacit`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (live && d && typeof d.tacit === 'string') setTacit(d.tacit); })
      .catch(() => null);
    return () => { live = false; };
  }, [workflowId]);

  async function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setRaw((r) => (r ? `${r}\n\n${text}` : text));
    if (fileRef.current) fileRef.current.value = '';
  }

  async function save() {
    if (saving) return;
    setSaving(true);
    setMsg('');
    try {
      const res = await fetch(`/api/knowledge/workflows/${workflowId}/tacit`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tacit }),
      });
      const data = await res.json();
      if (!res.ok) setMsg(`✗ ${serverMsg(data, t('tacit.saveFailed'))}`);
      else setMsg(t('tacit.saved'));
    } catch (e) {
      setMsg(`✗ ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="tacit-panel">
      {/* Current expert-knowledge doc (stored as the sibling tacit.md) */}
      <div className="section-title">{t('tacit.title')}</div>
      <textarea
        className="tacit-editor mono"
        rows={10}
        value={tacit}
        disabled={!canEdit}
        onChange={(e) => setTacit(e.target.value)}
        placeholder={t('tacit.placeholder')}
      />
      {canEdit && (
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginTop: 10 }}>
          {msg ? <span className={msg.startsWith('✓') ? 'hint' : 'error'} style={{ margin: 0 }}>{msg}</span> : <span />}
          <button className="btn" onClick={() => void save()} disabled={saving}>
            {saving ? <span className="spin" /> : t('tacit.save')}
          </button>
        </div>
      )}

      {canEdit && (
        <>
          {/* Capture */}
          <div className="section-title" style={{ marginTop: 24 }}>{t('tacit.captureTitle')}</div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
            <button className="btn ghost sm" onClick={() => fileRef.current?.click()}>{t('tacit.upload')}</button>
            <input ref={fileRef} type="file" accept=".txt,.md,.vtt,.srt,text/*" onChange={onUpload} style={{ display: 'none' }} />
            {/* Voice recording is not available yet — no Record button until transcription is real. */}
          </div>
          <textarea
            className="tacit-raw"
            rows={5}
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            placeholder={t('tacit.rawPlaceholder')}
          />
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
            <button
              className="btn ghost sm"
              onClick={() => { setTacit((cur) => (cur ? `${cur}\n\n${raw}` : raw)); setRaw(''); }}
              disabled={!raw.trim()}
            >
              {t('tacit.append')}
            </button>
          </div>
        </>
      )}

      <style>{TacitStyles}</style>
    </div>
  );
}

const TacitStyles = `
.tacit-editor, .tacit-raw {
  width: 100%;
  font-size: 12.5px; line-height: 1.55; resize: vertical;
  background: var(--bg-input); color: var(--text);
  border: 1px solid var(--border-strong); border-radius: 8px; padding: 11px;
}
.tacit-raw { font-family: var(--font-body); font-size: 13px; }
`;
