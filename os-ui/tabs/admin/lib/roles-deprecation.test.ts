/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        admin
 * FEATURE:    An old model name keeps working and logs a deprecation once the roles are mapped.
 * USER STORY: As a platform admin who has mapped the three roles, I see in the logs which settings still
 *             name an old alias, so I can move them before the alias goes away. Nothing breaks meanwhile.
 * ARCHITECTURE:
 *   - `roleModel` returns the configured name unchanged (the OS does no client-side resolution — the
 *     gateway resolves the alias); it only logs. Before any mapping exists nothing is logged: there is
 *     no migration to nag about.
 *   - NEGATIVE TWINS: a role name logs nothing; the same alias logs once, not on every call.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { roleModel } from '@core/models/roles';
import { updateSettings, _reset as resetSettings } from '@tabs/admin/lib/settings';

const warn = console.warn;
let lines: string[] = [];
beforeEach(() => {
  resetSettings();
  lines = [];
  console.warn = (l: string) => { lines.push(String(l)); };
  (globalThis as unknown as { __osRoleReport?: unknown }).__osRoleReport = undefined;
});
const mapped = () => { (globalThis as unknown as { __osRoleReport?: unknown }).__osRoleReport = { last: { mapping: { 'sovereign-strong': 'a', 'sovereign-worker': 'b', 'sovereign-embedding': 'c' } } }; };

test('before the roles are mapped nothing is logged', () => {
  updateSettings({ modelRoles: { standard: 'sovereign-premium' } });
  assert.equal(roleModel('standard'), 'sovereign-premium');
  console.warn = warn;
  assert.deepEqual(lines, []);
});

test('once mapped, an old alias still resolves to itself (the gateway maps it) and logs a deprecation ONCE', () => {
  mapped();
  updateSettings({ modelRoles: { reasoning: 'sovereign-vision' } });
  assert.equal(roleModel('reasoning'), 'sovereign-vision');
  assert.equal(roleModel('reasoning'), 'sovereign-vision');
  console.warn = warn;
  assert.equal(lines.filter((l) => /sovereign-vision/.test(l)).length, 1);
  assert.match(lines.find((l) => /sovereign-vision/.test(l))!, /deprecated.*sovereign-strong/i);
});

test('NEGATIVE TWIN: a role name or a catalog model name logs nothing', () => {
  mapped();
  updateSettings({ modelRoles: { standard: 'sovereign-worker', reasoning: 'stackit-qwen3-vl-235b' } });
  roleModel('standard');
  roleModel('reasoning');
  console.warn = warn;
  assert.deepEqual(lines, []);
});
