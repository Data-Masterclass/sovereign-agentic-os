/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * FEATURE:    The audited no-scan approval hatch on `decideDeploy`
 * USER STORY: As an administrator I must be able to ship a deploy when no scanner can run — but
 *             only by saying so explicitly, in writing, on the record. As an auditor I must be
 *             able to find every such approval, who made it and why.
 * ARCHITECTURE:
 *   The hatch is a GOVERNANCE control, not an exemption: it never makes the OS claim a clean
 *   scan, and it is unreachable when a scan RAN and FAILED — a real finding still blocks, which
 *   is the line that keeps this from becoming "click here to skip security".
 *
 *   Four gates, each asserted below: the scan must be `unavailable` (not failed), the actor must
 *   be `admin` (NOT domain_admin, which is the rank that approves artefact promotions and would
 *   otherwise inherit this by accident), the acknowledgement must be explicit, and the reason
 *   must be substantive (>= 20 characters — long enough that "ok" cannot be the record).
 *   The decision writes three places: the review card, the Governance approval's effect, and a
 *   hash-chained `core/policy/audit.ts` row.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@core/kernel/auth';
import { createApp, saveAppFile } from '@tabs/software/lib/apps';
import { requestDeploy, decideDeploy, __resetReviewCards } from './review.ts';
import { __resetApprovals, listApprovals } from '@core/policy/approvals';
import { __resetAudit, search, verifyChain } from '@core/policy/audit';

const creator: CurrentUser = { id: 'alice', name: 'Alice', domains: ['sales'], role: 'creator' };
const builder: CurrentUser = { id: 'bob', name: 'Bob', domains: ['sales'], role: 'builder' };
const domainAdmin: CurrentUser = { id: 'dana', name: 'Dana', domains: ['sales'], role: 'domain_admin' };
const admin: CurrentUser = { id: 'ada', name: 'Ada', domains: ['sales'], role: 'admin' };

const GOOD_REASON = 'Scanner Job cannot reach the Trivy DB mirror; reviewed the diff by hand with the security lead.';
const LEAKED = 'const key = "AKIAIOSFODNN7EXAMPLE";\n';

function reset(): void {
  __resetApprovals();
  __resetReviewCards();
  __resetAudit();
}

/** A pending review card whose scan produced NO verdict (the cluster-with-no-scanner case). */
async function cardWithNoVerdict(name: string): Promise<string> {
  const app = await createApp(creator, { name, template: 'nextjs-supabase' });
  const res = await requestDeploy(app.id, creator, { scanMode: 'unavailable' });
  assert.equal(res.kind, 'review');
  if (res.kind !== 'review') throw new Error('expected a review card');
  assert.equal(res.card.scan.unavailable, true);
  assert.equal(res.card.scan.passed, false);
  return res.card.id;
}

/**
 * A pending review card whose scan RAN and FAILED — the case the hatch must refuse. The file is
 * saved by the BUILDER because the code editor is Builder+ (`apps.ts` `ensureBuilder`); the
 * leaked key then reaches the scan through the app's durable file mirror, exactly as
 * `review-security.test.ts` pins.
 */
async function cardWithFailedScan(name: string): Promise<string> {
  const app = await createApp(builder, { name, template: 'nextjs-supabase' });
  await saveAppFile(app.id, builder, { path: 'lib/creds.ts', content: LEAKED, sha: '' });
  const res = await requestDeploy(app.id, builder, { scanMode: 'live' });
  assert.equal(res.kind, 'review');
  if (res.kind !== 'review') throw new Error('expected a review card');
  assert.equal(res.card.scan.passed, false);
  assert.notEqual(res.card.scan.unavailable, true, 'this scan RAN; it just failed');
  return res.card.id;
}

async function refusal(fn: () => Promise<unknown>): Promise<{ message: string; status: number }> {
  try {
    await fn();
  } catch (e) {
    return { message: (e as Error).message, status: (e as { status?: number }).status ?? 0 };
  }
  throw new Error('expected a refusal, got none');
}

// ------------------------------------------------------------- without the hatch --

test('WITHOUT the acknowledgement an absent verdict still blocks, for an admin too', async () => {
  reset();
  try {
    const id = await cardWithNoVerdict('No Hatch');
    const r = await refusal(() => decideDeploy(id, admin, 'approve'));
    assert.equal(r.status, 409);
    assert.match(r.message, /no security verdict to approve/i);
  } finally {
    reset();
  }
});

// ----------------------------------------------------------------- the role gate --

test('a DOMAIN_ADMIN cannot use the hatch — it is admin-only, and the refusal says so', async () => {
  reset();
  try {
    const id = await cardWithNoVerdict('Domain Admin Hatch');
    const r = await refusal(() =>
      decideDeploy(id, domainAdmin, 'approve', undefined, { acknowledgeNoScan: true, reason: GOOD_REASON }),
    );
    assert.equal(r.status, 403);
    assert.match(r.message, /administrator/i);
    assert.ok(/domain_admin|domain admin/i.test(r.message), 'the refusal must name the caller\'s rank');
    // And nothing was written anywhere.
    assert.deepEqual(search({ action: 'deploy' }), []);
  } finally {
    reset();
  }
});

test('a BUILDER cannot use the hatch either', async () => {
  reset();
  try {
    const id = await cardWithNoVerdict('Builder Hatch');
    const r = await refusal(() =>
      decideDeploy(id, builder, 'approve', undefined, { acknowledgeNoScan: true, reason: GOOD_REASON }),
    );
    assert.equal(r.status, 403);
  } finally {
    reset();
  }
});

// --------------------------------------------------------------- the reason gate --

test('a MISSING or SHORT reason is refused — the reason IS the record', async () => {
  reset();
  try {
    for (const bad of [undefined, '', '   ', 'ok', 'scanner broken', '   too short   ']) {
      const id = await cardWithNoVerdict(`Reason ${String(bad)}`);
      const r = await refusal(() =>
        decideDeploy(id, admin, 'approve', undefined, { acknowledgeNoScan: true, reason: bad }),
      );
      assert.equal(r.status, 400, `reason ${JSON.stringify(bad)} must be refused`);
      assert.match(r.message, /reason/i);
      assert.match(r.message, /20/, 'the refusal must state the floor it enforces');
    }
    assert.deepEqual(search({ action: 'deploy' }), [], 'a refused acknowledgement writes no audit row');
  } finally {
    reset();
  }
});

// -------------------------------------------------- a REAL failure is not a hatch --

test('a scan that RAN and FAILED can NEVER be acknowledged', async () => {
  reset();
  try {
    const id = await cardWithFailedScan('Real Failure');
    const r = await refusal(() =>
      decideDeploy(id, admin, 'approve', undefined, { acknowledgeNoScan: true, reason: GOOD_REASON }),
    );
    assert.equal(r.status, 409);
    assert.match(r.message, /did not pass/i);
    assert.ok(
      /cannot be acknowledged|only.*unavailable|no verdict/i.test(r.message),
      `the refusal must explain that the hatch does not apply: ${r.message}`,
    );
    assert.deepEqual(search({ action: 'deploy' }), []);
  } finally {
    reset();
  }
});

// -------------------------------------------------------------- the happy path ----

test('an ADMIN with an explicit acknowledgement and a real reason ships it, on the record', async () => {
  reset();
  try {
    const id = await cardWithNoVerdict('Acknowledged');
    const { app, card } = await decideDeploy(id, admin, 'approve', 'going ahead', {
      acknowledgeNoScan: true,
      reason: GOOD_REASON,
    });

    // 1. The app went live and the card records WHAT KIND of approval this was.
    assert.equal(app.deploy.state, 'live');
    assert.equal(card.decision, 'approved');
    assert.equal(card.decidedBy, 'ada');
    assert.equal(card.approvedWithoutScan, true);
    assert.equal(card.noScanReason, GOOD_REASON);

    // 2. The Governance approval carries the same fact through the recordEffect seam, so the
    //    inbox shows it without the Software tab retelling the story.
    const governed = listApprovals({}).filter((a) => a.kind === 'app_deploy');
    assert.equal(governed.length, 1);
    assert.equal(governed[0].status, 'approved');
    const effect = governed[0].effect?.approvedWithoutScan;
    assert.ok(effect, 'the approval effect must carry the acknowledgement');
    assert.equal(effect.by, 'ada');
    assert.equal(effect.reason, GOOD_REASON);
    assert.equal(effect.scanMode, 'unavailable');

    // 3. The audit log: one hash-chained `deploy` row naming the admin, the reason and the flag.
    const rows = search({ action: 'deploy' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actor, 'ada');
    assert.equal(rows[0].domain, 'sales');
    assert.equal(rows[0].reason, GOOD_REASON);
    assert.equal(rows[0].detail.approvedWithoutScan, true);
    assert.equal(rows[0].detail.cardId, id);
    assert.equal(rows[0].detail.appId, app.id);
    assert.equal(rows[0].detail.scanMode, 'unavailable');
    assert.ok(String(rows[0].detail.scanReason ?? '').length > 0, 'and WHY there was no verdict');
    assert.equal(verifyChain(), null, 'the acknowledgement cannot be removed without breaking the chain');
  } finally {
    reset();
  }
});

test('the acknowledgement is IGNORED when the scan passed — a normal approval stays normal', async () => {
  reset();
  try {
    const app = await createApp(creator, { name: 'Clean Scan', template: 'nextjs-supabase' });
    const res = await requestDeploy(app.id, creator, { scanMode: 'offline-mock' });
    assert.equal(res.kind, 'review');
    if (res.kind !== 'review') return;
    assert.equal(res.card.scan.passed, true);
    const { card } = await decideDeploy(res.card.id, admin, 'approve', undefined, {
      acknowledgeNoScan: true,
      reason: GOOD_REASON,
    });
    assert.equal(card.decision, 'approved');
    assert.equal(card.approvedWithoutScan, undefined, 'there was a verdict; nothing was waived');
    assert.deepEqual(search({ action: 'deploy' }), [], 'and nothing to audit as a waiver');
  } finally {
    reset();
  }
});

test('DENY needs no scanner and no acknowledgement, whatever the scan says', async () => {
  reset();
  try {
    const id = await cardWithNoVerdict('Denied');
    const { app, card } = await decideDeploy(id, builder, 'deny', 'not now');
    assert.equal(card.decision, 'denied');
    assert.equal(app.deploy.state, 'preview');
    assert.equal(card.approvedWithoutScan, undefined);
  } finally {
    reset();
  }
});
