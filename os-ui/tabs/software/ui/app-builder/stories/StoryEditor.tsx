/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder A - edit a story in place: title, the story line, state, criteria in Given/When/Then, notes
 * USER STORY: As a business user I want to write a story and its acceptance criteria in plain words, one Given, When or
 *             Then per line, and see exactly why a save was refused.
 * ARCHITECTURE:
 *   - A labelled form over a `StoryDraft` (model.ts); StoriesView saves it (PUT, one commit). Ids are never typed: a new
 *     criterion has no id and the server assigns the next `AC-<n>`. The server's validation issues are listed under the
 *     form in an alert, as the server wrote them (path, line, reason, fix).
 *   - Moving a story to another epic is choosing the epic; the server moves the file in the same commit.
 */
'use client';

import { useId, useState, type FormEvent } from 'react';
import { useTranslations } from '@core/i18n/client';
import type { EpicDoc, SpecIssue } from '@tabs/software/lib/app-builder-contracts';
import { emptyCriterion, type CriterionDraft, type SaveOutcome, type StoryDraft } from '@tabs/software/ui/app-builder/stories/model';

export default function StoryEditor({
  draft: initial,
  epics,
  onCancel,
  onSave,
}: {
  draft: StoryDraft;
  epics: EpicDoc[];
  onCancel: () => void;
  onSave: (d: StoryDraft) => Promise<SaveOutcome>;
}) {
  const t = useTranslations('software');
  const uid = useId();
  const [d, setD] = useState<StoryDraft>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<SpecIssue[]>([]);
  const set = <K extends keyof StoryDraft>(k: K, v: StoryDraft[K]) => setD((x) => ({ ...x, [k]: v }));
  const setC = (i: number, patch: Partial<CriterionDraft>) => setD((x) => ({ ...x, criteria: x.criteria.map((c, n) => (n === i ? { ...c, ...patch } : c)) }));
  const id = (name: string) => `${uid}-${name}`;

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
    <form className="card" onSubmit={submit} aria-labelledby={id('h')} data-testid="story-editor">
      <h5 id={id('h')} style={{ margin: '0 0 8px' }}>
        {d.id ? <span className="mono">{d.id} </span> : null}
        {d.id ? t('appBuilder.stories.edit') : t('appBuilder.stories.addStory')}
      </h5>
      <div className="sr-field">
        <label htmlFor={id('title')}>{t('appBuilder.stories.form.title')}</label>
        <input id={id('title')} required maxLength={200} value={d.title} onChange={(e) => set('title', e.target.value)} />
      </div>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <div className="sr-field">
          <label htmlFor={id('epic')}>{t('appBuilder.stories.form.epic')}</label>
          <select id={id('epic')} value={d.epic} onChange={(e) => set('epic', e.target.value)}>
            {epics.map((ep) => (
              <option key={ep.id} value={ep.id}>
                {ep.id} {ep.title}
              </option>
            ))}
          </select>
        </div>
        <div className="sr-field">
          <label htmlFor={id('state')}>{t('appBuilder.stories.form.state')}</label>
          <select id={id('state')} value={d.state} onChange={(e) => set('state', e.target.value === 'agreed' ? 'agreed' : 'draft')}>
            <option value="draft">{t('appBuilder.stories.status.draft')}</option>
            <option value="agreed">{t('appBuilder.stories.status.agreed')}</option>
          </select>
        </div>
      </div>
      {(['asA', 'iWant', 'soThat'] as const).map((k) => (
        <div className="sr-field" key={k}>
          <label htmlFor={id(k)}>{t(`appBuilder.stories.form.${k}`)}</label>
          <input id={id(k)} maxLength={500} value={d[k]} onChange={(e) => set(k, e.target.value)} />
        </div>
      ))}
      <fieldset style={{ border: 0, padding: 0, margin: '12px 0' }}>
        <legend>{t('appBuilder.stories.criteria')}</legend>
        {d.criteria.map((c, i) => (
          <fieldset key={c.id ?? `new-${i}`} className="card" style={{ marginBottom: 8 }}>
            <legend className="mono">{c.id ?? t('appBuilder.stories.form.newCriterion')}</legend>
            <div className="sr-field">
              <label htmlFor={id(`c${i}-title`)}>{t('appBuilder.stories.form.criterionTitle')}</label>
              <input id={id(`c${i}-title`)} maxLength={200} value={c.title} onChange={(e) => setC(i, { title: e.target.value })} />
            </div>
            {(['given', 'when', 'then'] as const).map((k) => (
              <div className="sr-field" key={k}>
                <label htmlFor={id(`c${i}-${k}`)}>{t(`appBuilder.stories.form.${k}`)}</label>
                <textarea id={id(`c${i}-${k}`)} rows={2} value={c[k]} onChange={(e) => setC(i, { [k]: e.target.value })} />
              </div>
            ))}
            <button type="button" className="btn ghost sm" onClick={() => setD((x) => ({ ...x, criteria: x.criteria.filter((_, n) => n !== i) }))}>
              {t('appBuilder.stories.form.removeCriterion', { id: c.id ?? String(i + 1) })}
            </button>
          </fieldset>
        ))}
        <button type="button" className="btn ghost sm" onClick={() => setD((x) => ({ ...x, criteria: [...x.criteria, emptyCriterion()] }))}>
          {t('appBuilder.stories.form.addCriterion')}
        </button>
      </fieldset>
      <div className="sr-field">
        <label htmlFor={id('notes')}>{t('appBuilder.stories.form.notes')}</label>
        <textarea id={id('notes')} rows={4} value={d.notes} onChange={(e) => set('notes', e.target.value)} />
      </div>
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
