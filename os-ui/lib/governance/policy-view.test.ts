/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Policy-plane read gate. Seeing the consolidated grant plane needs the
 * `policy.view` right — a User/Creator is denied; a Builder/Admin passes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canViewPolicyPlane, addAccessGrant, addEgressEndpoint, listEgress, __resetPlane } from './policy-view.ts';

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
