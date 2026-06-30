/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { Tier } from '../data/dataset-schema.ts';
import type { Role } from '../session.ts';
import { canTransition, tierAfter } from '../data/dataset-schema.ts';
import type { DashboardSpec } from './model.ts';

/**
 * Dashboard governance — identical tiers/roles to data + metrics:
 * Personal → promote to the Domain (Builder) → certify to the Marketplace (Admin).
 * Reuses the data lifecycle gate so dashboards can't drift from datasets/metrics on
 * who-may-do-what (a non-Builder cannot promote; only an Admin certifies). A shared or
 * certified dashboard stays per-viewer RLS-scoped via the guest token (embed.ts), so
 * broadening the tier never broadens the rows. Pure + tested.
 */

export type DashTier = 'personal' | 'domain' | 'marketplace';

const TIER_OF: Record<DashTier, Tier> = { personal: 'dataset', domain: 'asset', marketplace: 'product' };
const DASH_TIER: Record<Tier, DashTier> = { dataset: 'personal', asset: 'domain', product: 'marketplace' };

export type DashboardRecord = {
  id: string;
  spec: DashboardSpec;
  tier: DashTier;
  owner: string;
};

export function dashboardRecord(id: string, spec: DashboardSpec, owner: string, tier: DashTier = 'personal'): DashboardRecord {
  return { id, spec, tier, owner };
}

export type DashTransition = 'promote' | 'certify';
export type DashGovernResult = { ok: boolean; record: DashboardRecord; reason?: string };

/** Move a dashboard along the lifecycle, gated on the same role rule as data/metrics. */
export function governDashboard(record: DashboardRecord, transition: DashTransition, approver: { id: string; role: Role }): DashGovernResult {
  const fromTier = TIER_OF[record.tier];
  const gate = canTransition(approver.role, fromTier, transition);
  if (!gate.ok) return { ok: false, record, reason: gate.reason };
  const toTier = tierAfter(fromTier, transition);
  return { ok: true, record: { ...record, tier: DASH_TIER[toTier] } };
}

export function canPromote(role: Role): boolean {
  return canTransition(role, 'dataset', 'promote').ok;
}
export function canCertify(role: Role): boolean {
  return canTransition(role, 'asset', 'certify').ok;
}
