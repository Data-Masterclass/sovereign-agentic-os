/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/data/server';
import { transition as transitionDataset } from '@/lib/data/store';
import { delegatedToken } from '@/lib/infra/identity-server';
import { getMetric } from '@/lib/metrics/store';
import { governMetric, canPromote as canPromoteMetric } from '@/lib/metrics/governance';
import { exploreMetric } from '@/lib/metrics/build/explore-server';
import { enqueue, listApprovals } from '@/lib/governance/approvals';

export const dynamic = 'force-dynamic';

/** The pending promotion request key for a metric — matches what GET filters on. */
const isMetricRequest = (id: string) => (a: { kind: string; payload?: Record<string, unknown> }) =>
  a.kind === 'artifact_promote' && a.payload?.artifactKind === 'metric' && a.payload?.id === id;

/**
 * Promote a metric one rung — the SAME governance-ladder contract every tab's shared
 * <PromoteButton> speaks (0.1.102). The rung is DERIVED from the metric's tier
 * (Personal→promote, Domain→certify) so a bodyless POST is unambiguous:
 *   • a non-approver OWNER (a creator) FILES a request → `{ requested: true, approval }`,
 *     no more "needs a Builder" dead-end;
 *   • an approver runs the existing consistency-gated govern flow → `{ item }`.
 * The consistency gate + the dataset-materialisation invariant are preserved verbatim
 * from /api/metrics/govern — this route only adds the creator's request path.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requirePrincipal();
    const { id } = await ctx.params;
    const record = getMetric(id, user);
    if (record.tier === 'marketplace') {
      return NextResponse.json({ error: 'This metric is already certified' }, { status: 409 });
    }
    const transition: 'promote' | 'certify' = record.tier === 'personal' ? 'promote' : 'certify';

    // Non-approver OWNER at Personal → file a governed request rather than dead-end.
    if (transition === 'promote' && record.owner === user.id && !canPromoteMetric(user.role)) {
      const dup = listApprovals({ status: 'pending' }).find(isMetricRequest(id));
      if (dup) return NextResponse.json({ requested: true, approval: dup });
      const approval = enqueue({
        kind: 'artifact_promote',
        title: `Promote “${record.measure.name}” to a ${record.dataset.domain} domain metric`,
        detail: `${user.id} requests promoting the metric “${record.measure.name}” to a shared domain asset. A domain admin must approve.`,
        agent: user.id,
        domain: record.dataset.domain,
        requestedBy: user.id,
        tool: 'metric_promote',
        payload: { artifactKind: 'metric', id, name: record.measure.name },
        approverRole: 'domain_admin',
        scope: 'domain',
      });
      return NextResponse.json({ requested: true, approval });
    }

    // Approver path — the exact consistency-gated flow from /api/metrics/govern.
    const { token } = await delegatedToken('domain');
    const resolve = async (): Promise<number | null> => {
      const r = await exploreMetric(record.dataset, record.measure, token, {});
      const total = r.rows.reduce((sum, row) => sum + Number(row[r.member] ?? 0), 0);
      return r.rows.length ? total : null;
    };
    const result = await governMetric(record, transition, { id: user.id, role: user.role }, resolve);
    if (!result.ok) {
      return NextResponse.json({ error: result.reason, consistency: result.consistency }, { status: 403 });
    }
    if (record.dataset.tier === 'dataset') {
      return NextResponse.json(
        { error: 'Promote the underlying dataset to a governed asset in the Data tab first (request_promotion runs the physical publish) — a metric transition cannot materialise an un-published dataset tier here.' },
        { status: 409 },
      );
    }
    transitionDataset(record.dataset.id, user, transition);
    return NextResponse.json({ item: { id, tier: result.record.tier } });
  } catch (e) {
    return errorResponse(e);
  }
}

/** The pending promotion request for this metric (so the UI shows "awaiting approval"). */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requirePrincipal();
    const { id } = await ctx.params;
    const request = listApprovals({ status: 'pending' }).find(isMetricRequest(id)) ?? null;
    return NextResponse.json({ request });
  } catch (e) {
    return errorResponse(e);
  }
}
