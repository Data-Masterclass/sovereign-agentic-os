/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect, useState } from 'react';
import { createNoteFile, uploadErrorMessage } from '@tabs/files/lib/upload-client';
import { useTranslations, useServerMessage } from '@core/i18n/client';

/**
 * The EDIT surface for a NEW markdown note. A note is not a separate storage kind — it
 * is just a text/markdown FILE, so Save rides the EXACT raw-upload path an uploaded
 * file uses (createNoteFile → POST /api/files?upload=raw): the bytes are stored, the
 * extracted text is kept (a .md name is text-like) and it is indexed like any file. On
 * success the parent focuses the created file, which opens the read View — matching the
 * OS-wide "new opens in Edit, Save lands in View" model. No new storage plumbing.
 */
export default function NoteEditor({
  folder,
  onCreated,
  onClose,
}: {
  /** Where the note lands (the selected personal folder, or '/'). */
  folder: string;
  /** Called with the new file's id after a successful save (parent opens it in View). */
  onCreated: (id: string) => void;
  onClose: () => void;
}) {
  const t = useTranslations('files');
  const msg = useServerMessage();
  const [name, setName] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  // Esc closes; lock body scroll while the editor is open (mirrors Quick Look).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [onClose, busy]);

  const save = async () => {
    const title = name.trim();
    if (!title) { setErr(t('note.nameRequired')); return; }
    setErr(''); setBusy(true);
    const res = await createNoteFile(title, body, folder);
    setBusy(false);
    if ('error' in res) { setErr(uploadErrorMessage(res.error, t, msg)); return; }
    onCreated(res.id);
  };

  return (
    <div
      className="ql-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={t('note.aria')}
      onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
    >
      <div className="ql-panel">
        <div className="files-preview ql-body">
          <div className="preview-head">
            <div className="preview-head-title">
              <div className="preview-row">
                <span className="kind-chip kind-doc">{t('kind.md')}</span>
                <input
                  className="rename-input"
                  autoFocus
                  placeholder={t('note.namePlaceholder')}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  aria-label={t('note.nameAria')}
                />
              </div>
              <div className="preview-row preview-submeta">
                <span className="file-sub">{folder === '/' ? t('note.savesToRoot') : t('note.savesTo', { folder })}</span>
              </div>
            </div>
            <div className="preview-head-actions">
              <button className="btn primary sm" onClick={() => void save()} disabled={busy} aria-busy={busy}>
                {busy ? <><span className="spin" /> {t('note.saving')}</> : t('note.save')}
              </button>
              <button className="preview-close" onClick={onClose} aria-label={t('note.close')} disabled={busy}>×</button>
            </div>
          </div>

          <div>
            <label className="rail-group-title">{t('note.markdown')}</label>
            <textarea
              className="mono"
              rows={18}
              placeholder={t('note.bodyPlaceholder')}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              aria-label={t('note.bodyAria')}
              style={{ width: '100%', resize: 'vertical' }}
            />
          </div>

          {err ? <div className="error">{err}</div> : null}
        </div>
      </div>
    </div>
  );
}
