/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getSettings, updateSettings, _reset } from './settings.ts';

beforeEach(() => { _reset(); });

test('tenant currency defaults to EUR', () => {
  assert.equal(getSettings().currency, 'EUR');
});

test('currency is editable (patch merges, other groups untouched)', () => {
  const before = getSettings().branding.displayName;
  const s = updateSettings({ currency: 'CHF' });
  assert.equal(s.currency, 'CHF');
  // Merging currency does not clobber unrelated groups.
  assert.equal(s.branding.displayName, before);
});

test('an empty currency patch keeps the prior value (never blanks it)', () => {
  updateSettings({ currency: 'USD' });
  const s = updateSettings({ currency: '' });
  assert.equal(s.currency, 'USD');
});

test('a non-currency patch leaves the currency in place', () => {
  updateSettings({ currency: 'USD' });
  const s = updateSettings({ notifications: { email: 'x@y.z', backupFailure: false, costThreshold: false } });
  assert.equal(s.currency, 'USD');
});
