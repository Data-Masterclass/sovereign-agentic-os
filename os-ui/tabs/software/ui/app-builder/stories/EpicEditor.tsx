/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder A - create or edit an epic: title, description, technical / UX / governance requirements
 * USER STORY: As a business user I want to group my stories under an epic that says what it is for and which technical,
 *             UX and governance requirements apply to all of them.
 * ARCHITECTURE: A labelled form over an `EpicDraft` (model.ts); StoriesView saves it (PUT, one commit). The epic id is
 *             assigned by the server. Validation issues are shown as the server wrote them.
 */
'use client';

import { useId, useState, type FormEvent } from 'react';
import { useTranslations } from '@core/i18n/client';
import type { SpecIssue } from '@tabs/software/lib/app-builder-contracts';
import type { EpicDraft, SaveOutcome } from '@tabs/software/ui/app-builder/stories/model';

export default function EpicEditor({ draft: initial, onCancel, onSave }: { draft: EpicDraft; onCancel: () => void; onSave: (d: EpicDraft) => Promise<SaveOutcome> }) {
  const t = useTranslations('software');
  const uid = useId();
  const [d, setD] = useState<EpicDraft>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<SpecIssue[]>([]);
  const id = (name: string) => `${uid}-${name}`;
  const set = (k: keyof EpicDraft, v: string) => setD((x) => ({ ...x, [k]: v }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setIssues([]);
    const r = await onSave(d);
    setBusy(false);
    if (!r.ok) {
      setError(r.error);
      setIssues(r.issues ?? []);
    }
  };

  return (
    <form className="card" onSubmit={submit} aria-labelledby={id('h')} data-testid="epic-editor" style={{ marginTop: 12 }}>
      <h5 id={id('h')} style={{ margin: '0 0 8px' }}>
        {d.id ? <span className="mono">{d.id} </span> : null}
        {d.id ? t('appBuilder.stories.editEpic') : t('appBuilder.stories.addEpic')}
      </h5>
      <div className="sr-field">
        <label htmlFor={id('title')}>{t('appBuilder.stories.form.title')}</label>
        <input id={id('title')} required maxLength={200} value={d.title} onChange={(e) => set('title', e.target.value)} />
      </div>
      <div className="sr-field">
        <label htmlFor={id('description')}>{t('appBuilder.stories.form.description')}</label>
        <textarea id={id('description')} rows={3} value={d.description} onChange={(e) => set('description', e.target.value)} />
      </div>
      {(['technical', 'ux', 'governance'] as const).map((k) => (
        <div className="sr-field" key={k}>
          <label htmlFor={id(k)}>{t(`appBuilder.stories.${k}`)}</label>
          <textarea id={id(k)} rows={2} value={d[k]} onChange={(e) => set(k, e.target.value)} />
        </div>
      ))}
      {error ? (
        <div className="error" role="alert">
          <p>{t('appBuilder.stories.form.failed', { error })}</p>
          {issues.length > 0 ? (
            <ul>
              {issues.map((x, n) => (
                <li key={n}>
                  {x.reason}. {x.fix}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      <div className="row" style={{ gap: 8 }}>
        <button type="submit" className="btn sm" disabled={busy || !d.title.trim()}>
          {busy ? t('appBuilder.stories.form.saving') : t('appBuilder.stories.form.save')}
        </button>
        <button type="button" className="btn ghost sm" onClick={onCancel} disabled={busy}>
          {t('appBuilder.stories.form.cancel')}
        </button>
      </div>
    </form>
  );
}
