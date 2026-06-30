/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimsFromUser, delegate } from '../data/identity.ts';
import { guestTokenRequest, rlsFromSecurityContext, GUEST_TOKEN_TTL_SECONDS } from './embed.ts';

function tokenFor(id: string, region: string) {
  return delegate(claimsFromUser({ id, domains: ['sales'], role: 'participant', attributes: { region } }), 'domain');
}

test('R3 — the guest token carries the VIEWER\'s RLS; two viewers get different clauses', () => {
  const de = guestTokenRequest(tokenFor('amir', 'DE'), 'dash-uuid');
  const fr = guestTokenRequest(tokenFor('bea', 'FR'), 'dash-uuid');
  assert.deepEqual(de.rls, [{ clause: "region = 'DE'" }]);
  assert.deepEqual(fr.rls, [{ clause: "region = 'FR'" }]);
  assert.notDeepEqual(de.rls, fr.rls);
  assert.equal(de.user.username, 'amir');
  assert.equal(de.ttlSeconds, GUEST_TOKEN_TTL_SECONDS);
});

test('a viewer with no low-card attribute falls back to an entitlement-table join (never unfiltered)', () => {
  const rls = rlsFromSecurityContext({ sub: 'carol' });
  assert.equal(rls.length, 1);
  assert.match(rls[0].clause, /entitlements WHERE principal = 'carol'/);
});

test('the guest token is per-viewer — a non-delegated (service) identity is refused', () => {
  const bad = { ...tokenFor('amir', 'DE'), onBehalfOf: 'svc-superset' };
  assert.throws(() => guestTokenRequest(bad as never, 'dash-uuid'), /delegated identity/);
});

test('SQL injection in an attribute is escaped in the clause', () => {
  const rls = rlsFromSecurityContext({ region: "DE' OR '1'='1" });
  assert.match(rls[0].clause, /region = 'DE'' OR ''1''=''1'/);
});
