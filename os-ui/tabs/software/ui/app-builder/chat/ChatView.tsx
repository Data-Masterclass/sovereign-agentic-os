/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder - the Chat view (requirements become diff cards; approved changes show the build)
 * USER STORY: As an app builder I want to type a requirement, see how the OS classifies it as a story change, approve
 *             it, and watch tests and code being built for it.
 * ARCHITECTURE:
 *   - PLACEHOLDER created by W0; workstream B owns this folder (spec section 11 view 2). Text: `software`
 *     namespace, `appBuilder.chat.*`.
 */
'use client';

import { useTranslations } from '@core/i18n/client';
import type { AppBuilderViewProps } from '@tabs/software/ui/app-builder/AppBuilderShell';

export default function ChatView(_props: AppBuilderViewProps) {
  const t = useTranslations('software');
  return (
    <div className="card" data-testid="app-builder-chat">
      <h3>{t('appBuilder.chat.title')}</h3>
      <p className="muted">{t('appBuilder.chat.placeholder')}</p>
    </div>
  );
}
