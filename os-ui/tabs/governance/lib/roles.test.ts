/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
/**
 * TAB:        governance
 * FEATURE:    Tests for the role-definition surface now owned by Governance
 * USER STORY: As a reviewer I want proof that every role still resolves to a non-empty permission
 *             list after the move, so "Governance owns role definitions" cannot silently mean
 *             "nobody can do anything".
 * ARCHITECTURE:
 *   - Imports the data-only lib (a .tsx cannot be imported from a test in this harness).
 *   - Pure: no matrix write, no network, no OPA.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ROLES } from '@core/kernel/session';
import { COMPONENTS, CAPABILITIES, isApplicable } from '@core/policy/role-config';
import {
  ROLE_ORDER,
  roleDefinitions,
  hasCapability,
  pendingChanges,
  toggleCapability,
  type RolesView,
  type RoleMatrixWire,
} from '@tabs/governance/lib/roles';

test('GOVERNANCE: role definitions are readable here, and every role has permissions', () => {
  const defs = roleDefinitions();
  assert.deepEqual(defs.map((d) => d.id), [...ROLES]);
  for (const d of defs) {
    assert.ok(d.rights.length > 0, `${d.id} has no rights`);
    assert.ok(d.tools.length > 0, `${d.id} compiles to no OPA tools`);
    assert.ok(d.label.length > 0 && d.blurb.length > 0, `${d.id} is unlabelled`);
  }
});

test('GOVERNANCE: role definitions are ordered lowest → highest privilege', () => {
  assert.deepEqual([...ROLE_ORDER], [...ROLES]);
});

function view(): RolesView {
  const applicable: Record<string, typeof CAPABILITIES[number]['id'][]> = {};
  for (const c of COMPONENTS) applicable[c.id] = CAPABILITIES.map((k) => k.id).filter((k) => isApplicable(c.id, k));
  const matrix = Object.fromEntries(ROLES.map((r) => [r, Object.fromEntries(COMPONENTS.map((c) => [c.id, []]))])) as RoleMatrixWire;
  return { components: COMPONENTS, capabilities: CAPABILITIES, applicable, matrix, roles: roleDefinitions() };
}

test('GOVERNANCE: toggling a cell yields exactly one pending change and never mutates the source', () => {
  const v = view();
  const next = toggleCapability(v.matrix, 'builder', 'data', 'view');
  assert.equal(hasCapability(v.matrix, 'builder', 'data', 'view'), false, 'source matrix was mutated');
  assert.equal(hasCapability(next, 'builder', 'data', 'view'), true);

  const diffs = pendingChanges(v, next);
  assert.equal(diffs.length, 1);
  assert.deepEqual(
    { role: diffs[0].role, comp: diffs[0].comp, cap: diffs[0].cap, enabled: diffs[0].enabled },
    { role: 'builder', comp: 'data', cap: 'view', enabled: true },
  );
});

test('GOVERNANCE: a non-applicable cell can never produce a pending change', () => {
  const v = view();
  const comp = COMPONENTS.find((c) => CAPABILITIES.some((k) => !isApplicable(c.id, k.id)))!;
  const cap = CAPABILITIES.find((k) => !isApplicable(comp.id, k.id))!;
  const next = toggleCapability(v.matrix, 'creator', comp.id, cap.id);
  assert.equal(pendingChanges(v, next).length, 0);
});

test('GOVERNANCE: an unchanged working copy has no pending changes', () => {
  const v = view();
  assert.equal(pendingChanges(v, JSON.parse(JSON.stringify(v.matrix))).length, 0);
});
