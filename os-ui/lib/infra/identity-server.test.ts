/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

/**
 * M1: a client-supplied `viewerRegion` must NOT seed a real RLS security context for an
 * ordinary user (that would let anyone impersonate another region on the live path).
 * `delegatedToken` honors the body region ONLY for an admin (the "view as" affordance);
 * for every other role it is ignored and region derives from the session identity alone.
 */

let ACTING: { id: string; name: string; domains: string[]; allDomains: string[]; activeDomain: string | null; role: string } | null = null;
mock.module('@/lib/core/auth', {
  namedExports: { requireUser: async () => ACTING },
});

const { delegatedToken } = await import('./identity-server.ts');
const { propagate } = await import('@/lib/data/identity');

function acting(role: string) {
  ACTING = { id: `u_${role}`, name: role, domains: ['sales'], allDomains: ['sales'], activeDomain: null, role };
}

test('non-admin: body viewerRegion is IGNORED (no region in the security context)', async () => {
  acting('creator');
  const { token } = await delegatedToken('domain', { region: 'FR' });
  assert.equal(token.attributes.region, undefined, 'creator cannot inject a region');
  const ctx = propagate(token).cube.securityContext;
  assert.equal(ctx.region, undefined, 'no region reaches the live RLS security context');
});

test('builder: body viewerRegion is IGNORED', async () => {
  acting('builder');
  const { token } = await delegatedToken('domain', { region: 'DE' });
  assert.equal(token.attributes.region, undefined, 'builder cannot inject a region either');
});

test('admin: body viewerRegion IS honored (view-as affordance)', async () => {
  acting('admin');
  const { token } = await delegatedToken('domain', { region: 'FR' });
  assert.equal(token.attributes.region, 'FR', 'admin view-as seeds the region');
  const ctx = propagate(token).cube.securityContext;
  assert.equal(ctx.region, 'FR');
});

test('admin without a body region: no region seeded (derives from session)', async () => {
  acting('admin');
  const { token } = await delegatedToken('domain', {});
  assert.equal(token.attributes.region, undefined);
});
