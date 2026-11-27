/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder - the Code and runs view (commits, runs, releases per env, logs, env and database panels)
 * USER STORY: As an app builder I want to see every commit and run, which release serves Dev and Prod, its logs,
 *             and to roll back, set env and secrets, and see my database.
 * ARCHITECTURE:
 *   - PLACEHOLDER created by W0; workstream C2 owns this folder, D adds `EnvPanel`/`DatabasePanel` here (spec
 *     section 11 view 3). Text: `software` namespace, `appBuilder.runs.*`.
 */
'use client';

import { useTranslations } from '@core/i18n/client';
import type { AppBuilderViewProps } from '@tabs/software/ui/app-builder/AppBuilderShell';

export default function RunsView({ env }: AppBuilderViewProps) {
  const t = useTranslations('software');
  return (
    <div className="card" data-testid="app-builder-runs">
      <h3>{t('appBuilder.runs.title')}</h3>
      <p className="muted">{t('appBuilder.runs.placeholder', { env: t(`appBuilder.shell.${env}`) })}</p>
    </div>
  );
}
