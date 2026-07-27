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

test('standard-first escalation defaults ON (cost routing enabled out of the box)', () => {
  assert.equal(getSettings().standardFirstEscalation, true);
});

test('standard-first escalation toggles off and back on via a boolean patch', () => {
  assert.equal(updateSettings({ standardFirstEscalation: false }).standardFirstEscalation, false);
  assert.equal(updateSettings({ standardFirstEscalation: true }).standardFirstEscalation, true);
});

test('a non-boolean / absent escalation patch is NIL-SAFE — the prior value is kept', () => {
  updateSettings({ standardFirstEscalation: false });
  // An unrelated patch must not silently re-enable (or blank) the flag.
  assert.equal(updateSettings({ currency: 'GBP' }).standardFirstEscalation, false);
  // A garbage value is ignored, not coerced.
  assert.equal(updateSettings({ standardFirstEscalation: 'yes' as unknown as boolean }).standardFirstEscalation, false);
});
