/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import PageHeader from '@core/ui/PageHeader';
import AgentSystems from '@tabs/agents/ui/AgentSystems';

export default function AgentsPage() {
  return (
    <>
      <PageHeader title="Agents" crumb="governed agent systems" />
      <div className="content">
        <div>
          <AgentSystems />
        </div>
      </div>
    </>
  );
}
