/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getSettings, updateSettings, codedAppsEnabled, promoteAsView, autonomousAgentsEnabled, _reset } from '@tabs/admin/lib/settings';

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

test('coded apps default OFF (Declarative is the sole default path)', () => {
  assert.equal(getSettings().codedAppsEnabled, false);
  assert.equal(codedAppsEnabled(), false);
});

test('coded apps toggles on and back off via a boolean patch', () => {
  assert.equal(updateSettings({ codedAppsEnabled: true }).codedAppsEnabled, true);
  assert.equal(codedAppsEnabled(), true);
  assert.equal(updateSettings({ codedAppsEnabled: false }).codedAppsEnabled, false);
  assert.equal(codedAppsEnabled(), false);
});

test('coded-apps flag is NIL-SAFE — a partial PUT never accidentally enables it', () => {
  // Default OFF: an unrelated patch must not flip it on.
  assert.equal(updateSettings({ currency: 'GBP' }).codedAppsEnabled, false);
  // Once ON, an unrelated / garbage patch keeps it ON (only a real boolean flips it).
  updateSettings({ codedAppsEnabled: true });
  assert.equal(updateSettings({ currency: 'USD' }).codedAppsEnabled, true);
  assert.equal(updateSettings({ codedAppsEnabled: 'no' as unknown as boolean }).codedAppsEnabled, true);
});

test('promote-as-view defaults OFF (physical CTAS copy is the sole default path)', () => {
  assert.equal(getSettings().promoteAsView, false);
  assert.equal(promoteAsView(), false);
});

test('promote-as-view toggles on and back off via a boolean patch', () => {
  assert.equal(updateSettings({ promoteAsView: true }).promoteAsView, true);
  assert.equal(promoteAsView(), true);
  assert.equal(updateSettings({ promoteAsView: false }).promoteAsView, false);
  assert.equal(promoteAsView(), false);
});

test('promote-as-view flag is NIL-SAFE — a partial PUT never accidentally enables it', () => {
  assert.equal(updateSettings({ currency: 'GBP' }).promoteAsView, false);
  updateSettings({ promoteAsView: true });
  assert.equal(updateSettings({ currency: 'USD' }).promoteAsView, true);
  assert.equal(updateSettings({ promoteAsView: 'yes' as unknown as boolean }).promoteAsView, true);
});

test('autonomous-agents defaults OFF (nothing runs unattended by default)', () => {
  assert.equal(getSettings().autonomousAgentsEnabled, false);
  assert.equal(autonomousAgentsEnabled(), false);
});

test('autonomous-agents toggles on and back off via a boolean patch', () => {
  assert.equal(updateSettings({ autonomousAgentsEnabled: true }).autonomousAgentsEnabled, true);
  assert.equal(autonomousAgentsEnabled(), true);
  assert.equal(updateSettings({ autonomousAgentsEnabled: false }).autonomousAgentsEnabled, false);
  assert.equal(autonomousAgentsEnabled(), false);
});

test('autonomous-agents flag is NIL-SAFE — a partial PUT never accidentally enables it', () => {
  assert.equal(updateSettings({ currency: 'GBP' }).autonomousAgentsEnabled, false);
  updateSettings({ autonomousAgentsEnabled: true });
  assert.equal(updateSettings({ currency: 'USD' }).autonomousAgentsEnabled, true);
  assert.equal(updateSettings({ autonomousAgentsEnabled: 'yes' as unknown as boolean }).autonomousAgentsEnabled, true);
});
