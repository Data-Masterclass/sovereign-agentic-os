/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { _clearEgress, requestEgress, decideEgress, isHostApproved, listEgressRequests, logEgress, egressLog } from './egress-requests.ts';

beforeEach(() => _clearEgress());

test('request → approve → host is approved', () => {
  const r = requestEgress({ host: 'api.acme.io', domain: 'sales', reason: 'needs data', requestedBy: 'amir' });
  assert.equal(r.status, 'pending');
  assert.equal(isHostApproved('api.acme.io'), false);
  const decided = decideEgress(r.id, 'approve', 'sara');
  assert.equal(decided?.status, 'approved');
  assert.equal(isHostApproved('api.acme.io'), true);
});

test('request → reject → host stays blocked', () => {
  const r = requestEgress({ host: 'evil.example.com', domain: 'finance', reason: 'test', requestedBy: 'bob' });
  decideEgress(r.id, 'reject', 'sara');
  assert.equal(isHostApproved('evil.example.com'), false);
});

test('listEgressRequests filters by domain and status', () => {
  requestEgress({ host: 'a.com', domain: 'sales', reason: 'r', requestedBy: 'u' });
  requestEgress({ host: 'b.com', domain: 'finance', reason: 'r', requestedBy: 'u' });
  assert.equal(listEgressRequests({ domain: 'sales' }).length, 1);
  assert.equal(listEgressRequests({ status: 'pending' }).length, 2);
});

test('logEgress appends entries; egressLog returns most recent first', () => {
  logEgress({ host: 'first.com' });
  logEgress({ host: 'second.com' });
  const log = egressLog(10);
  assert.equal(log[0].host, 'second.com');
  assert.equal(log[1].host, 'first.com');
});

test('globalThis pin: egressState is shared under soa.egress.requests', () => {
  requestEgress({ host: 'test.io', domain: 'sales', reason: 'pin test', requestedBy: 'x' });
  const pinned = (globalThis as Record<symbol, unknown>)[Symbol.for('soa.egress.requests')] as { requests: Map<string, unknown> };
  assert.ok(pinned, 'state must be present on globalThis');
  assert.equal(pinned.requests.size, 1, 'request must appear in globalThis state');
});
