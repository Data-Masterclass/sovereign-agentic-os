/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
/**
 * TAB:        governance
 * FEATURE:    Tests for the egress allowlist — host normalization, request decisions, singleton pinning
 * USER STORY: As a platform admin I want a bad host rejected and an approved request to actually
 *             reach the allowlist, so an egress decision is never silently lost.
 * ARCHITECTURE:
 *   - Moved from tabs/admin/lib/platform-admin.test.ts on 2026-10-30 with the lib itself; keeping
 *     them there would have made an admin test import @tabs/governance (TAB-ISOLATION).
 *   - Node's test runner + the @tabs alias hook; no network, no Next runtime.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  _reset as resetSec,
  addAllowlist,
  removeAllowlist,
  decideRequest,
  listRequests,
  listAllowlist,
} from '@tabs/governance/lib/egress';

test('egress: allowlist add/remove + approve request joins allowlist', () => {
  resetSec();
  addAllowlist('https://api.acme.io/v1');
  assert.ok(listRequests().length >= 1);
  const reqId = listRequests()[0].id;
  const { host } = decideRequest(reqId, 'approved');
  assert.ok(host && host.includes('.'));
  removeAllowlist('api.acme.io');
});

test('egress: bad host is rejected', () => {
  resetSec();
  assert.throws(() => addAllowlist('not-a-host'), (e: { status?: number }) => e.status === 400);
});

test('globalThis pin: egress allowlist + requests are shared singletons (egress.ts)', () => {
  resetSec();
  addAllowlist('api.acme.io');
  // The allowlist is pinned to globalThis — a separately-bundled route resolving
  // Symbol.for('soa.platform-admin.egress-allow') sees the SAME Set.
  const allowPinned = (globalThis as Record<symbol, unknown>)[Symbol.for('soa.platform-admin.egress-allow')] as Set<string>;
  assert.ok(allowPinned instanceof Set, 'allow is pinned as a Set on globalThis');
  assert.ok(allowPinned.has('api.acme.io'), 'added host is visible via the globalThis pin');
  assert.ok(listAllowlist().includes('api.acme.io'), 'listAllowlist() reads the same pinned Set');

  // The requests map is pinned to its own symbol key and seeded once.
  const reqPinned = (globalThis as Record<symbol, unknown>)[Symbol.for('soa.platform-admin.egress-requests')] as Map<string, unknown>;
  assert.ok(reqPinned instanceof Map, 'requests is pinned as a Map on globalThis');
  assert.ok(reqPinned.has('egr_demo'), 'the seed request is visible via the globalThis pin');
  assert.equal(listRequests().length, reqPinned.size, 'listRequests() reads the same pinned Map');
});
