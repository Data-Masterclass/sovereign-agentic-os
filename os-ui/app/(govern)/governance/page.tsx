/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import PageHeader from '@core/ui/PageHeader';
import { useUser } from '@core/ui/useUser';
import { roleAtLeast, type Role } from '@core/kernel/session';
import ApprovalsInbox from '@tabs/governance/ui/ApprovalsInbox';
import PoliciesView from '@tabs/governance/ui/PoliciesView';
import AuditLog from '@tabs/governance/ui/AuditLog';
import CostLimits from '@tabs/governance/ui/CostLimits';
import RolesView from '@tabs/governance/ui/RolesView';
import EgressView from '@tabs/governance/ui/EgressView';

type Section = 'inbox' | 'policies' | 'roles' | 'egress' | 'audit' | 'cost';

// `minRole` gates a tab STRIP ENTRY. The Governance tab itself is minRole
// 'builder' (core/kernel/tabs.ts), but defining what a role may do and curating
// the egress allowlist are admin-only policy acts — so those two entries carry
// their own floor, and their components fail closed again on their own.
const SECTIONS: { id: Section; label: string; minRole?: Role }[] = [
  { id: 'inbox', label: 'Inbox' },
  { id: 'policies', label: 'Policies' },
  { id: 'roles', label: 'Roles & permissions', minRole: 'admin' },
  { id: 'egress', label: 'Security & egress', minRole: 'admin' },
  { id: 'audit', label: 'Audit' },
  { id: 'cost', label: 'Cost & limits' },
];

export default function GovernancePage() {
  return (
    <Suspense fallback={null}>
      <GovernancePageInner />
    </Suspense>
  );
}

function GovernancePageInner() {
  const searchParams = useSearchParams();
  const { user, loading } = useUser();
  const role = user?.role ?? null;

  // A deep-link from a tab's "Go to Policies & Approvals →" carries ?focus=<id>
  // so we land on the inbox and highlight the just-filed request.
  const focus = searchParams?.get('focus') ?? null;
  // ?section=<id> deep-links a tab (Platform → Users & Access links to roles,
  // the overview alert links to egress). Applied in an effect too, so an
  // in-page <Link> to ?section=… switches without a remount.
  const sectionParam = searchParams?.get('section') ?? null;
  const [section, setSection] = useState<Section>(
    SECTIONS.some((s) => s.id === sectionParam) ? (sectionParam as Section) : 'inbox',
  );
  useEffect(() => {
    if (sectionParam && SECTIONS.some((s) => s.id === sectionParam)) setSection(sectionParam as Section);
  }, [sectionParam]);

  // Fail closed: a gated entry is hidden while the role is unresolved, so an
  // admin-only tab never flashes into a builder's strip.
  const canSee = (s: { minRole?: Role }) =>
    !s.minRole || (!loading && role !== null && roleAtLeast(role, s.minRole));
  const visible = SECTIONS.filter(canSee);
  const current = visible.some((s) => s.id === section) ? section : null;

  return (
    <>
      <PageHeader
        title="Governance"
        crumb="control plane · approve · policy · roles · egress · audit · cost"
      />
      <div className="content">
        <div className="tabstrip" style={{ marginBottom: 24 }}>
          {visible.map((s) => (
            <button
              key={s.id}
              className={section === s.id ? 'active' : ''}
              onClick={() => setSection(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>

        {current === 'inbox' && <ApprovalsInbox focusId={focus} />}
        {current === 'policies' && <PoliciesView />}
        {current === 'roles' && <RolesView />}
        {current === 'egress' && <EgressView />}
        {current === 'audit' && <AuditLog />}
        {current === 'cost' && <CostLimits />}
      </div>
    </>
  );
}
