/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __resetAudit, record, search, verifyChain } from './audit.ts';
import { __resetStanding, remember, isRemembered } from './standing.ts';

beforeEach(() => {
  __resetAudit();
  __resetStanding();
});

test('every action is recorded with who/when/why and a verifiable chain', () => {
  record({ actor: 'bea', action: 'deploy', subject: 'app1', domain: 'sales', reason: 'approved' });
  record({ actor: 'sara', action: 'policy.override', subject: 'user:amir→query', domain: 'tenant', reason: 'revoked' });
  const all = search();
  assert.equal(all.length, 2);
  for (const e of all) {
    assert.ok(e.actor && e.at && e.reason && e.action && e.subject); // who/when/why
  }
  assert.equal(verifyChain(), null); // chain intact
});

test('audit search filters by q, action, and domain scope', () => {
  record({ actor: 'bea', action: 'deploy', subject: 'renewal', domain: 'sales', reason: 'deploy approved' });
  record({ actor: 'kenji', action: 'cost.cap.set', subject: 'finance', domain: 'finance', reason: 'set cap' });
  assert.equal(search({ action: 'deploy' }).length, 1);
  assert.equal(search({ q: 'renewal' }).length, 1);
  // Builder scope: only their domains.
  const scoped = search({ domains: ['sales'] });
  assert.ok(scoped.every((e) => e.domain === 'sales'));
});

test('approve & remember writes a standing policy that matches the same request shape', () => {
  const sp = remember({ kind: 'access_request', payload: { dataset: 'mart_sales' }, domain: 'sales', createdBy: 'bea', fromApproval: 'apr_1' });
  assert.ok(sp.id);
  assert.equal(isRemembered('access_request', { dataset: 'mart_sales' }), true);
  assert.equal(isRemembered('access_request', { dataset: 'other' }), false);
});
