/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal } from '@tabs/data/lib/server';
import { withRoute } from '@core/kernel/route-server';
import type { CurrentUser } from '@core/kernel/auth';
import { transition as transitionDataset, policyPushReport } from '@tabs/data/lib/store';
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
  return NextResponse.json({ item: { id, tier: result.record.tier }, ...(await policyPushReport(record.dataset.id)) });
}, { gate: requirePrincipal as () => Promise<CurrentUser> });

/**
 * What the shared <PromoteButton> polls on mount. There is never a pending metric promotion
 * request — nothing files one, because nothing could apply one — so `request` is always null.
 *
 * But answering ONLY that left the control enabled and every click a 409. A gate the UI cannot
 * see is a button that exists to fail, so the Personal tier reports its `gate` with the reason
 * and the dataset to act on: the caller disables the control and shows the sentence instead of
 * discovering it on click. Same shape the Data tab's promote GET already returns
 * (`{ gate: { ok, reason } }`), so one control can read both.
 */
export const GET = withRoute<{ id: string }>(async ({ user, params }) => {
  const { id } = params;
  const record = getMetric(id, user); // view gate; an unseeable metric is not_found
  if (record.tier !== 'personal') {
    return NextResponse.json({ request: null, gate: { ok: true } });
  }
  return NextResponse.json({
    request: null,
    gate: {
      ok: false,
      reason:
        `A metric's audience is its dataset's audience — promote the dataset “${record.dataset.name}” ` +
        'to Domain in the Data tab and this metric follows.',
      datasetId: record.dataset.id,
    },
  });
}, { gate: requirePrincipal as () => Promise<CurrentUser> });
