/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/data/server';
import { transition as transitionDataset } from '@/lib/data/store';
import { delegatedToken } from '@/lib/identity-server';
import { getMetric } from '@/lib/metrics/store';
import { governMetric } from '@/lib/metrics/governance';
import { exploreMetric } from '@/lib/metrics/build/explore-server';

export const dynamic = 'force-dynamic';

/**
 * Promote (Builder → Domain) / certify (Admin → Marketplace) a metric. The role gate is
 * shared with data (a non-Builder cannot promote; only an Admin certifies) and the
 * CONSISTENCY gate must pass — documented + defined + RESOLVES on its canonical member
 * (resolved here under the approver's identity, the same member dashboards + the agent
 * read). On success we persist the tier move through the Data store, so the metric and
 * its dataset can never drift on tier.
 */
export async function POST(req: Request) {
  try {
    const user = await requirePrincipal();
    const body = (await req.json().catch(() => ({}))) as { metricId?: string; transition?: 'promote' | 'certify' };
    const metricId = (body.metricId ?? '').trim();
    const transition = body.transition;
    if (!metricId || (transition !== 'promote' && transition !== 'certify')) {
      return NextResponse.json({ error: "metricId and transition ('promote'|'certify') are required" }, { status: 400 });
    }

    const record = getMetric(metricId, user);
    const { token } = await delegatedToken('domain');
    const resolve = async (): Promise<number | null> => {
      const r = await exploreMetric(record.dataset, record.measure, token, {});
      const total = r.rows.reduce((sum, row) => sum + Number(row[r.member] ?? 0), 0);
      return r.rows.length ? total : null;
    };

    const result = await governMetric(record, transition, { id: user.id, role: user.role }, resolve);
    if (!result.ok) {
      return NextResponse.json({ ok: false, reason: result.reason, consistency: result.consistency }, { status: 403 });
    }

    // INVARIANT (effects.ts): a dataset tier flip that would MATERIALIZE (dataset →
    // asset) must run the physical publish — it can never be a bare tier relabel.
    // A metric is defined on an already-governed asset, so its dataset is materialised;
    // if it is somehow still a private `dataset`, refuse here and send the caller to
    // the Data tab's request_promotion (which runs the governed physical publish).
    if (record.dataset.tier === 'dataset') {
      return NextResponse.json(
        { ok: false, reason: 'Promote the underlying dataset to a governed asset in the Data tab first (request_promotion runs the physical publish) — a metric transition cannot materialise an un-published dataset tier here.' },
        { status: 409 },
      );
    }
    // Only a NON-materialising move remains (asset → product certify): the physical
    // table already exists, so relabelling the tier (like the direct Admin certify)
    // is safe and keeps the metric + its dataset from drifting on tier.
    const dataset = transitionDataset(record.dataset.id, user, transition);
    return NextResponse.json({ ok: true, metricId, tier: result.record.tier, consistency: result.consistency, dataset });
  } catch (e) {
    return errorResponse(e);
  }
}
