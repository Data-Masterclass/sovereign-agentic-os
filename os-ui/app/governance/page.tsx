/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';
import PageHeader from '@/components/PageHeader';
import ApprovalsInbox from '@/components/governance/ApprovalsInbox';
import PoliciesView from '@/components/governance/PoliciesView';
import AuditLog from '@/components/governance/AuditLog';
import CostLimits from '@/components/governance/CostLimits';
import UsersAccess from '@/components/governance/UsersAccess';

type Section = 'inbox' | 'policies' | 'audit' | 'cost' | 'users';

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'inbox', label: 'Inbox' },
  { id: 'policies', label: 'Policies' },
  { id: 'audit', label: 'Audit' },
  { id: 'cost', label: 'Cost & limits' },
  { id: 'users', label: 'Users & access' },
];

export default function GovernancePage() {
  const [section, setSection] = useState<Section>('inbox');

  return (
    <>
      <PageHeader
        title="Governance"
        crumb="control plane · approve · policy · audit · cost · access"
      />
      <div className="content">
        <div className="tabstrip" style={{ marginBottom: 24 }}>
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              className={section === s.id ? 'active' : ''}
              onClick={() => setSection(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>

        {section === 'inbox' && <ApprovalsInbox />}
        {section === 'policies' && <PoliciesView />}
        {section === 'audit' && <AuditLog />}
        {section === 'cost' && <CostLimits />}
        {section === 'users' && <UsersAccess />}
      </div>
    </>
  );
}
