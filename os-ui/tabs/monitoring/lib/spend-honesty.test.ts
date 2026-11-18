/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    NODE_ENV=production ⇒ tenant spend reports NO figure, and raises NO alert
 * USER STORY: As an admin I must never see a spend percentage the OS did not read, and I must
 *             never be alerted about one. Review H1: both platform-admin routes called
 *             `offlineSpend(tenant.envelopeEUR)` unconditionally, so the deployed cluster showed
 *             62% of its own envelope as spend — derived from the envelope — and the overview
 *             raised a real "Spend at 62% of envelope" warning off it.
 * ARCHITECTURE:
 *   - `tenantSpendView` is the ONE door both routes call, so this test covers both. The routes
 *     themselves are `route.ts` files a test may not import (they pull `next/headers`), which is
 *     exactly why the decision was moved out of them.
 *   - NULL, not zero. "Spend could not be read" and "nothing has been spent" are different facts
 *     and the tile must not be able to show the second when it means the first — so the test
 *     asserts `null` specifically, and asserts the alert threshold cannot fire on it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tenantSpendView } from '@tabs/monitoring/lib/spend';
import { OFFLINE_MOCK_ENV } from '@core/kernel/offline-mock';

const ENVELOPE = 2000;
const CAP = 400;

function withEnv<T>(nodeEnv: string, flag: string | undefined, body: () => T): T {
  const prevNode = process.env.NODE_ENV;
  const prevFlag = process.env[OFFLINE_MOCK_ENV];
  (process.env as Record<string, string>).NODE_ENV = nodeEnv;
  if (flag === undefined) delete process.env[OFFLINE_MOCK_ENV];
  else process.env[OFFLINE_MOCK_ENV] = flag;
  try {
    return body();
  } finally {
    if (prevNode === undefined) delete process.env.NODE_ENV;
    else (process.env as Record<string, string>).NODE_ENV = prevNode;
    if (prevFlag === undefined) delete process.env[OFFLINE_MOCK_ENV];
    else process.env[OFFLINE_MOCK_ENV] = prevFlag;
  }
}

test('PRODUCTION + flag unset: no spend figure, no trend, source `unavailable`', () => {
  const v = withEnv('production', undefined, () => tenantSpendView(ENVELOPE, CAP));
  assert.equal(v.source, 'unavailable');
  assert.equal(v.spendEUR, null, 'null, NOT 0 — zero would read as "nothing spent"');
  assert.equal(v.premiumSpendEUR, null);
  assert.equal(v.pctUsed, null);
  assert.equal(v.premiumPctUsed, null);
  assert.deepEqual(v.trend, []);
  assert.match(v.reason ?? '', /cannot be read/i);
  // The CONFIGURED ceilings are still reported: they are the tenant's own settings, not readings.
  assert.equal(v.envelopeEUR, ENVELOPE);
  assert.equal(v.premiumCapEUR, CAP);
});

test('PRODUCTION: the overview alert cannot fire — the threshold has no number to clear', () => {
  const v = withEnv('production', undefined, () => tenantSpendView(ENVELOPE, CAP));
  // This is the exact condition `app/api/platform-admin/overview/route.ts` evaluates.
  assert.equal(v.pctUsed !== null && v.pctUsed >= 80, false);
  assert.equal(v.hardStop, false, 'and no hard-stop indicator off an unread figure');
  assert.equal(v.premiumHardStop, false);
});

test('PRODUCTION + an explicit `allow`: the demo figures are back, and labelled', () => {
  const v = withEnv('production', 'allow', () => tenantSpendView(ENVELOPE, CAP));
  assert.equal(v.source, 'offline-mock');
  assert.equal(v.spendEUR, 1240, '62% of the envelope — the deterministic demo figure');
  assert.equal(v.trend.length, 6);
});

test('a laptop is byte-identical to before', () => {
  const v = withEnv('development', undefined, () => tenantSpendView(ENVELOPE, CAP));
  assert.equal(v.source, 'offline-mock');
  assert.equal(v.pctUsed, 62);
});

test('REAL figures bypass the gate entirely — the gate governs only the invented fallback', () => {
  const v = withEnv('production', undefined, () =>
    tenantSpendView(ENVELOPE, CAP, { spendEUR: 17, premiumSpendEUR: 3, trend: [1, 2, 3, 4, 5, 17] }),
  );
  assert.equal(v.source, 'litellm');
  assert.equal(v.spendEUR, 17);
  assert.equal(v.pctUsed, 1);
});
