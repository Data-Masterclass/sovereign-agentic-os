/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder A - one story card: title, status chip, test light, the story line, criteria in Given/When/Then
 * USER STORY: As a business user I want to read a story at a glance: what it is for, whether it is agreed, whether its
 *             tests are green, and exactly which acceptance criteria it has.
 * ARCHITECTURE:
 *   - Presentational; data and actions come from StoriesView. Status (`draft/agreed/built/verified`) and light
 *     (`green/partial/untested`) are badges WITH text. Criteria are an ordered list; each keyword group is a
 *     description list so a screen reader announces "Given … When … Then …".
 */
'use client';

import type { ReactNode } from 'react';
import { useTranslations } from '@core/i18n/client';
import { LIGHT_BADGE, STATUS_BADGE, type StoryRow } from '@tabs/software/ui/app-builder/stories/model';

export default function StoryCard({
  story,
  canEdit,
  historyOpen,
  onEdit,
  onToggleHistory,
}: {
  story: StoryRow;
  canEdit: boolean;
  historyOpen: boolean;
  onEdit: () => void;
  onToggleHistory: () => void;
}) {
  const t = useTranslations('software');
  const b = (chunks: ReactNode) => <strong>{chunks}</strong>;
  return (
    <article className="card" aria-label={`${story.id} ${story.title}`} data-testid={`story-${story.id}`}>
      <div className="row" style={{ alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <h5 style={{ margin: 0, fontSize: '1rem' }}>
          <span className="mono">{story.id}</span> {story.title}
        </h5>
        <span className={STATUS_BADGE[story.status]}>
          {t('appBuilder.stories.statusLabel')}: {t(`appBuilder.stories.status.${story.status}`)}
        </span>
        <span className={LIGHT_BADGE[story.light]}>
          {t('appBuilder.stories.lightLabel')}: {t(`appBuilder.stories.light.${story.light}`)}
        </span>
        <span style={{ marginLeft: 'auto' }} />
        <button type="button" className="btn ghost sm" aria-expanded={historyOpen} onClick={onToggleHistory}>
          {historyOpen ? t('appBuilder.stories.hideHistory') : t('appBuilder.stories.history')}
        </button>
        {canEdit ? (
          <button type="button" className="btn ghost sm" onClick={onEdit}>
            {t('appBuilder.stories.edit')}
          </button>
        ) : null}
      </div>
      {story.asA || story.iWant || story.soThat ? (
        <p>{t.rich('appBuilder.stories.storyLine', { asA: story.asA, iWant: story.iWant, soThat: story.soThat, b })}</p>
      ) : null}
      <h6 style={{ margin: '8px 0 4px', fontSize: '0.9rem' }}>{t('appBuilder.stories.criteria')}</h6>
      {story.criteria.length === 0 ? (
        <p className="muted">{t('appBuilder.stories.noCriteria')}</p>
      ) : (
        <ol style={{ paddingLeft: 18 }}>
          {story.criteria.map((c) => (
            <li key={c.id}>
              <span className="mono">{c.id}</span> {c.title}
              <dl style={{ margin: '4px 0 8px' }}>
                {(['given', 'when', 'then'] as const).map((k) => (
                  <div key={k} className="row" style={{ gap: 6 }}>
                    <dt className="muted" style={{ minWidth: 56 }}>{t(`appBuilder.stories.${k}`)}</dt>
                    <dd style={{ margin: 0 }}>
                      {c[k].map((line, i) => (
                        <div key={i}>{line}</div>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </li>
          ))}
        </ol>
      )}
      {story.notes ? (
        <details>
          <summary>{t('appBuilder.stories.notes')}</summary>
          <p style={{ whiteSpace: 'pre-wrap' }}>{story.notes}</p>
        </details>
      ) : null}
    </article>
  );
}
