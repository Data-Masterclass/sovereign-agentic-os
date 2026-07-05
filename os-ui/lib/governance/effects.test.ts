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
import {
  __resetStore as __resetFiles,
  createFile,
  setDocs,
  requestPromotion,
  getFile,
} from '../files/store.ts';

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

test('approve IS an action: a file_promote approval actually shares the file to the domain', async () => {
  __resetFiles();
  const owner = { id: 'kai', domains: ['cohort'], role: 'creator' as const };
  const peer = { id: 'pat', domains: ['cohort'], role: 'creator' as const };
  const f = createFile(owner, { name: 'campaign_master.csv', folder: 'campaign-data', tags: ['data'], text: 'a,b\n1,2\n' });
  setDocs(f.id, owner, { description: 'campaign row data', tags: ['data'] });
  const req = requestPromotion(f.id, owner, { visibility: 'domain' });
  // Before approval the peer cannot see the private file.
  assert.throws(() => getFile(f.id, peer), /not|permit|found|denied/i);
  // Approve → the effect must MOVE the file to a domain asset (not a no-op mock).
  const r = await applyEffect(
    appr({ kind: 'file_promote', domain: 'cohort', payload: req as unknown as Record<string, unknown> }),
    'cohort-instructor',
  );
  assert.equal(r.ok, true);
  assert.equal(r.live, true);
  assert.match(r.applied, /campaign_master\.csv/);
  // The peer can now read the shared file (domain visibility).
  const seen = getFile(f.id, peer);
  assert.equal(seen.asset.tier, 'asset');
  assert.equal(seen.asset.visibility, 'domain');
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

// ---- T8: dataset_promote is a PHYSICAL publish -------------------------------

const promoteReq = {
  datasetId: 'ds_x',
  datasetName: 'Orders',
  domain: 'sales',
  owner: 'amir',
  visibility: 'domain',
  grants: [],
  target: 'iceberg.sales.gold_orders',
};

test('dataset_promote passes the APPROVER identity (real role + domains) to the publisher', async () => {
  let got: { id: string; role: string; domains: string[] } | null = null;
  const r = await applyEffect(
    appr({ kind: 'dataset_promote', payload: promoteReq }),
    { id: 'bea', role: 'builder', domains: ['sales'] },
    {
      publishPromotion: async (req, approver) => {
        got = approver;
        return {
          ok: true, fqn: req.target, mode: 'live',
          report: { ok: true, rows: [], skipped: [] }, cubeView: 'Orders',
          dataset: { name: req.datasetName, id: req.datasetId, tier: 'asset' } as never,
        };
      },
    },
  );
  assert.deepEqual(got, { id: 'bea', role: 'builder', domains: ['sales'] });
  assert.equal(r.ok, true);
  assert.equal(r.live, true);
  assert.deepEqual(r.publish, { ok: true, fqn: 'iceberg.sales.gold_orders', mode: 'live', cubeView: 'Orders' });
  assert.match(r.applied, /iceberg\.sales\.gold_orders/);
});

test('dataset_promote FAILURE: the effect reports ok:false with the real error (tier untouched)', async () => {
  const r = await applyEffect(
    appr({ kind: 'dataset_promote', payload: promoteReq }),
    { id: 'bea', role: 'builder', domains: ['sales'] },
    {
      publishPromotion: async (req) => ({
        ok: false, fqn: req.target, mode: 'live',
        report: { ok: false, rows: [], skipped: [] },
        error: 'Trino: Access Denied on personal_amir',
      }),
    },
  );
  assert.equal(r.ok, false);
  assert.equal(r.live, false);
  assert.equal(r.publish?.ok, false);
  assert.match(r.publish?.error ?? '', /Access Denied/);
  assert.match(r.applied, /tier unchanged/);
});

test('dataset_promote FAILS LOUD when no physical publisher is injected (no silent flip)', async () => {
  await assert.rejects(
    () => applyEffect(appr({ kind: 'dataset_promote', payload: promoteReq }), 'bea'),
    /publishPromotion/,
  );
});
