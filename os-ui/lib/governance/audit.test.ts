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

// ---- Audit read scoping — builder's search must not leak foreign domain entries ----

test('builder search({}) returns only their own domain entries, never foreign domain entries', () => {
  // Seed entries for two domains.
  record({ actor: 'bea', action: 'deploy', subject: 'app1', domain: 'sales', reason: 'sales deploy' });
  record({ actor: 'kenji', action: 'cost.cap.set', subject: 'budget', domain: 'finance', reason: 'finance cap' });

  // A builder in 'sales' must not see finance entries — use the domains filter
  // (the route/API applies this for non-admin users).
  const salesOnly = search({ domains: ['sales'] });
  assert.ok(salesOnly.length > 0, 'the builder sees their own domain entries');
  assert.ok(salesOnly.every((e) => e.domain === 'sales'), 'no foreign domain entries returned');

  // Confirm the finance entry is excluded.
  assert.ok(!salesOnly.some((e) => e.domain === 'finance'), 'finance entry must not appear in sales search');
});

test('admin search({}) (no domains filter) returns entries for all domains', () => {
  record({ actor: 'bea', action: 'deploy', subject: 'app2', domain: 'sales', reason: 'sales' });
  record({ actor: 'kenji', action: 'deny', subject: 'budget', domain: 'finance', reason: 'finance' });

  // Without a domains restriction an admin sees everything.
  const all = search({});
  const domains = new Set(all.map((e) => e.domain));
  assert.ok(domains.has('sales') && domains.has('finance'), 'admin sees both domains');
});
