/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder - the Stories view (epics, story cards, criteria, history, pending diff cards)
 * USER STORY: As a business user I want to see and edit my app's epics and user stories, each with its status and
 *             test light, and see who changed what.
 * ARCHITECTURE:
 *   - PLACEHOLDER created by W0; workstream A owns this folder (spec section 11 view 1). Text: `software`
 *     namespace, `appBuilder.stories.*`.
 */
'use client';

import { useTranslations } from '@core/i18n/client';
import type { AppBuilderViewProps } from '@tabs/software/ui/app-builder/AppBuilderShell';

export default function StoriesView({ app }: AppBuilderViewProps) {
  const t = useTranslations('software');
  return (
    <div className="card" data-testid="app-builder-stories">
      <h3>{t('appBuilder.stories.title')}</h3>
      <p className="muted">{t('appBuilder.stories.placeholder', { app: app.name })}</p>
    </div>
  );
}
