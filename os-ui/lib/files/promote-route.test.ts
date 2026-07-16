/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Files "Propose to Domain" — the builder-can-PROPOSE requirement, driven through
 * the REAL /api/files/[id]/promote route handler.
 *
 * Proves the governed model end-to-end at the route seam:
 *   • an OWNER who is only a builder can FILE request_promotion on their OWN file;
 *   • the enqueued approval is scoped domain / approverRole = domain_admin, so the
 *     inbox `canApprove` gate lets a domain_admin+ approve but NOT a plain builder;
 *   • a NON-owner (even a builder in the domain) cannot propose someone else's file.
 */

let ACTING: { id: string; name: string; domains: string[]; role: string } | null = null;
mock.module('@/lib/core/auth', {
  namedExports: {
    requireUser: async () => ACTING,
    currentUser: async () => ACTING,
  },
});
const { __resetStore, createFile, setDocs } = await import('./store.ts');
const { __resetApprovals, listApprovals } = await import('../governance/approvals.ts');
const { canApprove } = await import('../governance/roles.ts');

beforeEach(() => {
  __resetStore();
  __resetApprovals();
});

async function loadRoute() {
  return import(`../../app/api/files/[id]/promote/route.ts?${Math.random()}`);
}
async function callPost(id: string) {
  const route = await loadRoute();
  const req = new Request('http://x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  return route.POST(req, { params: Promise.resolve({ id }) });
}

/** Seed a promotable (documented) file owned by `owner`. */
function documentedFile(owner: { id: string; domains: string[]; role: 'creator' | 'builder' | 'domain_admin' | 'admin' }) {
  const p: import('./store.ts').Principal = { id: owner.id, domains: owner.domains, role: owner.role };
  const a = createFile(p, { name: 'handbook.pdf', tags: ['guide'], text: 'the sales handbook' });
  setDocs(a.id, p, { description: 'the domain sales handbook', tags: ['guide'] });
  return a;
}

test('a BUILDER can PROPOSE promoting their OWN file → files a domain_admin-gated request', async () => {
  const bea = { id: 'bea', name: 'Bea', domains: ['sales'], role: 'builder' as const };
  ACTING = bea;
  const a = documentedFile(bea);

  const res = await callPost(a.id);
  assert.equal(res.status, 200, 'a builder-owner may file a promotion proposal');
  const body = await res.json();
  assert.ok(body.approval, 'an approval was enqueued');
  assert.equal(body.approval.kind, 'file_promote');
  assert.equal(body.approval.requestedBy, 'bea');
  assert.equal(body.approval.approverRole, 'domain_admin', 'Personal→Domain is a domain_admin gate');
  assert.equal(body.approval.scope, 'domain');

  // It really landed in the shared inbox as pending.
  const pending = listApprovals({ status: 'pending' }).find((x) => x.kind === 'file_promote' && x.payload?.fileId === a.id);
  assert.ok(pending, 'the proposal appears in the approvals inbox');

  // Inbox gate: a domain_admin of the domain may approve; a plain builder may NOT.
  assert.equal(canApprove({ id: 'dana', domains: ['sales'], role: 'domain_admin' }, pending!), true, 'a domain_admin approves');
  assert.equal(canApprove({ id: 'ben', domains: ['sales'], role: 'builder' }, pending!), false, 'a plain builder cannot approve');
});

test('a NON-owner (even an in-domain builder) cannot propose someone else’s file', async () => {
  const amir = { id: 'amir', name: 'Amir', domains: ['sales'], role: 'creator' as const };
  const a = documentedFile(amir);

  ACTING = { id: 'bea', name: 'Bea', domains: ['sales'], role: 'builder' }; // in-domain, but NOT the owner
  const res = await callPost(a.id);
  assert.equal(res.status, 403, 'only the file owner may propose its promotion');
  assert.equal(listApprovals({ status: 'pending' }).length, 0, 'nothing was enqueued');
});
