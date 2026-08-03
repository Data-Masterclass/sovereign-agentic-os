/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { transition as transitionDataset } from '@/lib/data/store';
import { getMetric } from '@/lib/metrics/store';

export const dynamic = 'force-dynamic';

/**
 * Revoke sharing one step — the mirror of ./promote. A metric's tier is DERIVED
 * from its dataset (a metric is a governed measure ON a dataset), so demoting a
 * metric demotes the underlying DATASET one rung — which moves the dataset and
 * every metric defined on it together: marketplace → domain (decertify, Admin) →
 * personal (unshare, owner/in-domain Domain admin). The dataset store re-enforces
 * the gate (named-individual grants block unshare; live domain imports block
 * decertify) and audits the transition. Nothing is deleted.
 */
export const POST = withRoute<{ id: string }>(async ({ user, params }) => {
  const { id } = params;
  const record = getMetric(id, user);
  if (record.tier === 'personal') {
    return NextResponse.json({ error: 'This metric is already personal — nothing to revoke' }, { status: 409 });
  }
  const action: 'decertify' | 'unshare' = record.tier === 'marketplace' ? 'decertify' : 'unshare';
  transitionDataset(record.dataset.id, user, action);
  const item = getMetric(id, user); // re-read: the tier is derived from the dataset
  return NextResponse.json({ item, action });
}, { defaultStatus: 500 });
