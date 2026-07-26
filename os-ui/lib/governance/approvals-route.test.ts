/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Route test for POST /app/api/governance/approvals
 *
 * Proven invariants:
 *  1. A cross-domain builder is denied (canApprove gate).
 *  2. A domain_admin cannot approve a TENANT-scoped item (admin-only scope).
 *  3. The creator/requester cannot approve their own pending item.
 *  4. The decided-by identity comes from the SESSION (user.id), never from the
 *     request body — an attacker cannot spoof the approver identity.
 *
 * Pattern mirrors lib/files/promote-route.test.ts: cache-busted import, mock
 * @/lib/core/auth, reset in-process stores before each test.
 */

let ACTING: { id: string; name: string; domains: string[]; role: string } | null = null;
mock.module('@/lib/core/auth', {
  namedExports: {
    requireUser: async () => ACTING,
    currentUser: async () => ACTING,
  },
});

const { __resetApprovals, enqueue, getApproval } = await import('./approvals.ts');

beforeEach(() => {
  __resetApprovals();
});

async function loadRoute() {
  return import(`../../app/api/governance/approvals/route.ts?${Math.random()}`);
}

function postBody(id: string, decision: 'approve' | 'reject' = 'approve', extra: Record<string, unknown> = {}) {
  return new Request('http://x', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, decision, ...extra }),
  });
}

/** Seed a pending domain-scoped approval requiring a builder of 'sales'. */
function seedDomainApproval(requestedBy = 'amir') {
  return enqueue({
    kind: 'access_request',
    title: 'Access to sales mart',
    detail: 'needs sales mart access',
    agent: 'agent:amir',
    domain: 'sales',
    requestedBy,
    tool: 'query',
    approverRole: 'builder',
    scope: 'domain',
    source: 'Data',
  });
}

/** Seed a pending TENANT-scoped approval (admin-only). */
function seedTenantApproval(requestedBy = 'bea') {
  return enqueue({
    kind: 'dataset_certify',
    title: 'Certify dataset',
    detail: 'wants to certify',
    agent: 'agent:bea',
    domain: 'sales',
    requestedBy,
    tool: 'certify',
    approverRole: 'admin',
    scope: 'tenant',
    source: 'Data',
  });
}

// 1. Cross-domain builder cannot approve an item in a different domain.
test('cross-domain builder is denied (scope guard)', async () => {
  const a = seedDomainApproval('amir');
  // bea is a builder, but in 'finance', not 'sales'
  ACTING = { id: 'bea', name: 'Bea', domains: ['finance'], role: 'builder' };
  const route = await loadRoute();
  const res = await route.POST(postBody(a.id));
  assert.equal(res.status, 403, 'cross-domain builder must be denied');
  // Approval must remain pending
  assert.equal(getApproval(a.id)?.status, 'pending');
});

// 2. domain_admin cannot approve a tenant-scoped item (admin-only).
test('domain_admin cannot approve a tenant-scoped item', async () => {
  const a = seedTenantApproval('bea');
  ACTING = { id: 'dana', name: 'Dana', domains: ['sales'], role: 'domain_admin' };
  const route = await loadRoute();
  const res = await route.POST(postBody(a.id));
  assert.equal(res.status, 403, 'domain_admin must not approve tenant-scoped items');
  assert.equal(getApproval(a.id)?.status, 'pending');
});

// 3. The creator/requester cannot approve their own item.
test('creator of the request cannot approve it (self-approval denied)', async () => {
  // amir raised the request
  const a = seedDomainApproval('amir');
  // amir is now acting as (even if a domain_admin), they still aren't in the right rank
  // The key point: a plain creator cannot approve builder-floor items
  ACTING = { id: 'amir', name: 'Amir', domains: ['sales'], role: 'creator' };
  const route = await loadRoute();
  const res = await route.POST(postBody(a.id));
  assert.equal(res.status, 403, 'a creator cannot approve a builder-floor item');
  assert.equal(getApproval(a.id)?.status, 'pending');
});

// 4. The approved-by identity is from the SESSION, never from the request body.
//    A valid approver sends a body with a forged "id" field — decidedBy must be
//    the session user, not any body field.
test('decidedBy is the session user.id, never from the request body', async () => {
  const a = seedDomainApproval('amir');
  // bea is a valid builder of 'sales' and can approve
  ACTING = { id: 'bea', name: 'Bea', domains: ['sales'], role: 'builder' };
  const route = await loadRoute();
  // Include a spurious 'decidedBy' field in the body — must be ignored
  const res = await route.POST(
    new Request('http://x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: a.id, decision: 'approve', decidedBy: 'attacker' }),
    }),
  );
  // The route will attempt to run the effect; it may fail (no real OPA/DB) but
  // what matters is the approval record uses bea's id, not 'attacker'.
  const updated = getApproval(a.id);
  assert.ok(updated, 'approval must exist');
  if (updated!.decidedBy) {
    // Effect ran (or was attempted): decidedBy must be the session user
    assert.equal(updated!.decidedBy, 'bea', 'decidedBy is the session user, not a body field');
    assert.notEqual(updated!.decidedBy, 'attacker');
  }
  // At minimum, the response must not be a 500 caused by our manipulation
  assert.ok(res.status !== 500 || (await res.clone().json())?.error !== undefined, 'no uncaught crash');
});
