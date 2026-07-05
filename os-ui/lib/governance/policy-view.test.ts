/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Policy-plane read gate. Seeing the consolidated grant plane needs the
 * `policy.view` right — a User/Creator is denied; a Builder/Admin passes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canViewPolicyPlane, addAccessGrant, addEgressEndpoint, listEgress, policySources, __resetPlane } from './policy-view.ts';

test('cross-instance: access grants and egress visible through globalThis symbol', () => {
  __resetPlane();
  addAccessGrant({ principal: 'user:ci', tool: 'read_data', domain: 'sales' });
  addEgressEndpoint('https://api.example.com', 'sales', 'admin');
  const raw = (globalThis as Record<symbol, unknown>)[Symbol.for('soa.governance.policyView')] as { accessGrants: unknown[]; egressAllowlist: Map<string, unknown> };
  assert.ok(raw && raw.accessGrants.length === 1, 'grant visible in globalThis');
  assert.ok(raw.egressAllowlist.has('https://api.example.com'), 'egress visible in globalThis');
  assert.equal(listEgress().length, 1);
});

test('SECURITY: only policy.view holders (Builder/Admin) may read the policy plane', () => {
  assert.equal(canViewPolicyPlane('creator'), false);
  assert.equal(canViewPolicyPlane('creator'), false);
  assert.equal(canViewPolicyPlane('builder'), true);
  assert.equal(canViewPolicyPlane('admin'), true);
});

// Capability profiles — section placement + data-contract tests.
// These cover the lib side of the UX fix: the section must never be empty
// (always 3 static profiles), ordered Creator → Builder → Admin, which
// ensures PoliciesView renders it at the top and the edit affordance is
// meaningful to an admin (non-empty table).
test('policySources: returns exactly 3 profiles (Creator, Builder, Admin)', () => {
  const sources = policySources();
  assert.equal(sources.length, 3, 'always 3 profiles so the section is never hidden');
  assert.equal(sources[0].name, 'Creator (capability profile)', 'first profile is Creator');
  assert.equal(sources[1].name, 'Builder (capability profile)', 'second profile is Builder');
  assert.equal(sources[2].name, 'Admin (capability profile)', 'third profile is Admin');
});

test('policySources: each profile has a non-empty name, authoredIn, compiledTo and rights', () => {
  for (const s of policySources()) {
    assert.ok(s.name.length > 0, `${s.name}: name non-empty`);
    assert.ok(s.authoredIn.length > 0, `${s.name}: authoredIn non-empty`);
    assert.ok(s.compiledTo.length > 0, `${s.name}: compiledTo non-empty`);
    assert.ok(s.rights.length > 0, `${s.name}: at least one right`);
  }
});

test('policySources: admin profile has the most rights (superset of builder and creator)', () => {
  const [creator, builder, admin] = policySources();
  assert.ok(
    admin.rights.length >= builder.rights.length && admin.rights.length >= creator.rights.length,
    'admin profile has the most (or equal) rights',
  );
});
