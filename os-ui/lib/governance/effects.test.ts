/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Approval } from '../approvals.ts';
import { applyEffect } from './effects.ts';
import {
  __resetPlane,
  consolidatedPlane,
  isEgressAllowed,
  isRevoked,
  overrideRevoke,
} from './policy-view.ts';

function appr(p: Partial<Approval> & Pick<Approval, 'kind'>): Approval {
  return {
    id: 'apr_test',
    title: 'x',
    detail: 'x',
    agent: 'agent',
    domain: 'sales',
    requestedBy: 'bea',
    tool: 'tool',
    payload: {},
    approverRole: 'builder',
    scope: 'domain',
    rememberable: false,
    source: 'test',
    status: 'pending',
    createdAt: new Date().toISOString(),
    ...p,
  };
}

beforeEach(() => __resetPlane());

test('approve IS an action: a deploy-review approval executes a (mock) deploy', async () => {
  const r = await applyEffect(appr({ kind: 'deploy_review', payload: { app: 'renewal-forecaster' } }), 'bea');
  assert.equal(r.ok, true);
  assert.equal(r.audit.action, 'deploy');
  assert.match(r.applied, /renewal-forecaster/);
  assert.equal(r.live, false); // Argo unwired on kind → marked mock
});

test('approve IS an action: an access request GRANTS access so the consumer can query', async () => {
  const r = await applyEffect(
    appr({ kind: 'access_request', payload: { consumer: 'user:amir', tool: 'query', dataset: 'mart_sales' } }),
    'bea',
  );
  assert.equal(r.audit.action, 'access.grant');
  assert.deepEqual(r.grant, { principal: 'user:amir', tool: 'query' });
  // The grant is now in the consolidated plane → the consumer can query.
  const plane = consolidatedPlane([], ['sales']);
  assert.ok(plane.some((g) => g.principal === 'user:amir' && g.tool === 'query' && g.source === 'access-grant'));
});

test('approve IS an action: an egress request allowlists the endpoint', async () => {
  const endpoint = 'https://crm.internal/api';
  const r = await applyEffect(appr({ kind: 'egress_request', payload: { endpoint } }), 'sara');
  assert.equal(r.audit.action, 'egress.allow');
  assert.equal(isEgressAllowed(endpoint), true);
});

test('Admin override revokes a granted access from the plane', async () => {
  await applyEffect(appr({ kind: 'access_request', payload: { consumer: 'user:amir', tool: 'query' } }), 'bea');
  assert.ok(consolidatedPlane([], ['sales']).some((g) => g.principal === 'user:amir' && g.tool === 'query'));
  overrideRevoke('user:amir', 'query');
  assert.equal(isRevoked('user:amir', 'query'), true);
  assert.ok(!consolidatedPlane([], ['sales']).some((g) => g.principal === 'user:amir' && g.tool === 'query'));
});

test('autonomous + promote effects run and audit correctly', async () => {
  const a = await applyEffect(appr({ kind: 'autonomous_out_of_policy', payload: { action: 'web_fetch x' } }), 'sara');
  assert.equal(a.audit.action, 'approve');
  assert.match(a.applied, /once/);
  const p = await applyEffect(appr({ kind: 'promote_certify', payload: { artifact: 'fact:q1', stage: 'certified' } }), 'bea');
  assert.match(p.applied, /certified/);
});
