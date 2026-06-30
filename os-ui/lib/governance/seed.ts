/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { type Approval } from '@/lib/approvals';

/**
 * Governance approvals seeding hook. A fresh tenant starts EMPTY — there are no
 * demo approval requests. Real approvals are enqueued by the governed adapters
 * (Software deploy-review, Agents out-of-policy, Data/Connections access +
 * egress, promote/certify) as users exercise the platform.
 */
export function seedGovernanceDemo(_domain = 'sales'): Approval[] {
  void _domain;
  return [];
}
