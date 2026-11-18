/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal } from '@tabs/data/lib/server';
import { withRoute } from '@core/kernel/route-server';
import type { CurrentUser } from '@core/kernel/auth';
import { transition as transitionDataset } from '@tabs/data/lib/store';
import { delegatedToken } from '@core/infra/identity-server';
import { getMetric } from '@tabs/metrics/lib/store';
import { governMetric } from '@tabs/metrics/lib/governance';
import { exploreMetric } from '@tabs/metrics/lib/build/explore-server';

export const dynamic = 'force-dynamic';

/**
 * Walk a metric one rung on the audience ladder — the contract every tab's shared
 * <PromoteButton> speaks. The rung is DERIVED from the metric's tier so a bodyless POST is
 * unambiguous, and the consistency gate + the dataset-materialisation invariant are preserved
 * verbatim from /api/metrics/govern.
 *
 * THE ONE THING TO KNOW ABOUT METRICS. A metric is not an artefact with an audience of its
 * own: it IS a measure on a governed dataset, and its tier is read straight off that dataset.
 * So My→Domain is the DATASET's move, and this route says so instead of offering a request no
 * approver can apply (see the POST). Domain→Company remains an Admin act here, because
 * certifying the measure and certifying the table it reads are the same decision and must not
 * be able to drift apart.
 */
export const POST = withRoute<{ id: string }>(async ({ user, params }) => {
  const { id } = params;
  const record = getMetric(id, user);
  if (record.tier === 'marketplace') {
    return NextResponse.json({ error: 'This metric is already certified' }, { status: 409 });
  }
  const transition: 'promote' | 'certify' = record.tier === 'personal' ? 'promote' : 'certify';

  // A METRIC HAS NO AUDIENCE OF ITS OWN. A metric IS a measure on a governed dataset, and
  // `tabs/metrics/lib/store.ts` reads its tier straight off that dataset (`TIER_OF[d.tier]`).
  // So `tier === 'personal'` means the DATASET is still private, and the only move that can
  // widen this metric's audience is promoting the dataset — a different artifact, with its own
  // documentation gate and its own physical publish.
  //
  // This branch used to FILE an `artifactKind: 'metric'` request. Nothing could ever apply it:
  // `applyLadder` has no metric case, so a domain admin's approve answered 502 and the request
  // sat pending forever. A promise the system cannot keep is worse than a refusal, so the
  // refusal now names the dataset and the action that actually works.
  if (transition === 'promote') {
    return NextResponse.json(
      {
        error:
          `A metric's audience is its dataset's audience — promote the dataset “${record.dataset.name}” to Domain in the Data tab ` +
          'and this metric follows.',
        datasetId: record.dataset.id,
      },
      { status: 409 },
    );
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
}, { gate: requirePrincipal as () => Promise<CurrentUser> });

/**
 * What the shared <PromoteButton> polls on mount. There is NEVER a pending metric promotion
 * request to report: nothing files one any more, because nothing could apply one. Answering
 * `{ request: null }` keeps the control's contract (it reads `data.request`) and keeps it
 * honest — an "awaiting approval" pill over a request that does not exist is the worst of the
 * three possible answers.
 */
export const GET = withRoute<{ id: string }>(async ({ user, params }) => {
  void user; // gate enforces auth; user not needed for the read
  void params;
  return NextResponse.json({ request: null });
}, { gate: requirePrincipal as () => Promise<CurrentUser> });
