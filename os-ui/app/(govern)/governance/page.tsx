/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import PageHeader from '@/components/PageHeader';
import { anchorAttr, ANCHORS } from '@/lib/tutorials';
import ApprovalsInbox from '@/components/governance/ApprovalsInbox';
import PoliciesView from '@/components/governance/PoliciesView';
import AuditLog from '@/components/governance/AuditLog';
import CostLimits from '@/components/governance/CostLimits';

type Section = 'inbox' | 'policies' | 'audit' | 'cost';

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'inbox', label: 'Inbox' },
  { id: 'policies', label: 'Policies' },
  { id: 'audit', label: 'Audit' },
  { id: 'cost', label: 'Cost & limits' },
];

/** Stable tutorial coach-mark targets on the section switcher. */
const SECTION_ANCHOR: Partial<Record<Section, string>> = {
  inbox: ANCHORS.governance.sandbox,
  audit: ANCHORS.governance.audit,
  cost: ANCHORS.governance.cost,
};

export default function GovernancePage() {
  return (
    <Suspense fallback={null}>
      <GovernancePageInner />
    </Suspense>
  );
}

function GovernancePageInner() {
  const searchParams = useSearchParams();
  // A deep-link from a tab's "Go to Policies & Approvals →" carries ?focus=<id>
  // so we land on the inbox and highlight the just-filed request.
  const focus = searchParams?.get('focus') ?? null;
  const [section, setSection] = useState<Section>('inbox');

  return (
    <>
      <PageHeader
        title="Governance"
        crumb="control plane · approve · policy · audit · cost"
        tutorial="governance"
      />
      <div className="content">
        <div className="tabstrip" style={{ marginBottom: 24 }}>
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              className={section === s.id ? 'active' : ''}
              {...(SECTION_ANCHOR[s.id] ? anchorAttr(SECTION_ANCHOR[s.id]!) : {})}
              onClick={() => setSection(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>

        {section === 'inbox' && <ApprovalsInbox focusId={focus} />}
        {section === 'policies' && <PoliciesView />}
        {section === 'audit' && <AuditLog />}
        {section === 'cost' && <CostLimits />}
      </div>
    </>
  );
}
