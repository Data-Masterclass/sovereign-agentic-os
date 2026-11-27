/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import PageHeader from '@core/ui/PageHeader';
import AgentSystems from '@tabs/agents/ui/AgentSystems';
import { useTranslations } from '@core/i18n/client';

export default function AgentsPage() {
  const t = useTranslations('agents');
  return (
    <>
      <PageHeader title={t('page.title')} crumb={t('page.crumb')} />
      <div className="content">
        <div>
          <AgentSystems />
        </div>
      </div>
    </>
  );
}
