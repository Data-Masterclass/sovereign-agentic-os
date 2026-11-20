/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        admin
 * FEATURE:    Read-only listing of LIVE domains whose id is already reserved
 * USER STORY: As an operator I want to know, from a read-only export of the domains index, which
 *             existing domains already clash with a reserved id — reported, never fixed for me.
 * ARCHITECTURE: `reservedDomainClashes` over `domainIdsFromJson` (the same export reader the
 *             collision listing uses); pure, writes nothing. Twin: a clean export lists nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { domainIdsFromJson, reservedDomainClashes } from '@tabs/admin/lib/domains';

test('lists every live domain whose id is reserved, with the reason', () => {
  const ids = domainIdsFromJson(JSON.stringify({ hits: { hits: [{ _source: { id: 'sales' } }, { _source: { id: 'domain-sales' } }, { _source: { id: 'personal_bob' } }, { _source: { id: 'platform' } }] } }));
  const clashes = reservedDomainClashes(ids);
  assert.deepEqual(clashes.map((c) => c.id), ['domain-sales', 'personal_bob', 'platform']);
  for (const c of clashes) assert.ok(c.reason.length > 0);
});

test('TWIN: a clean export lists nothing', () => {
  assert.deepEqual(reservedDomainClashes([{ id: 'sales' }, { id: 'marketing-eu' }]), []);
});
