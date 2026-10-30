/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 *
 * TAB:        monitoring
 * FEATURE:    Covers the spend-vs-envelope math that moved here from Platform.
 * USER STORY: As a maintainer I want the envelope percentages and hard-stop flags
 *             pinned, so a change to the spend surface cannot silently under-report
 *             how much of the tenant's budget is gone.
 * ARCHITECTURE:
 *   - Pure unit test over `spend.ts`; no I/O, no route, no JSX (a .tsx file cannot be
 *     imported by this harness, which is why the math lives in a .ts sibling).
 *   - Moved out of `tabs/admin/lib/platform-admin.test.ts`: a test importing
 *     `@tabs/monitoring/*` from inside the admin tab is a TAB-ISOLATION violation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { billingView, offlineSpend } from '@tabs/monitoring/lib/spend';

test('spend: usage-vs-envelope, hard-stop at/over the cap', () => {
  const { spendEUR, premiumSpendEUR, trend } = offlineSpend(2000);
  const v = billingView({ envelopeEUR: 2000, premiumCapEUR: 400, spendEUR, premiumSpendEUR, trend, source: 'offline-mock' });
  assert.equal(v.pctUsed, 62);
  assert.equal(v.hardStop, false);
  const over = billingView({ envelopeEUR: 1000, premiumCapEUR: 100, spendEUR: 1000, premiumSpendEUR: 120, trend: [], source: 'offline-mock' });
  assert.equal(over.hardStop, true);
  assert.equal(over.premiumHardStop, true);
});
