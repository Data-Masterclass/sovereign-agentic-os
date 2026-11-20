/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       admin
 * FEATURE:    Platform → Cluster shows the real nodes or the reason it cannot (WP-05).
 * USER STORY: As a platform admin I want the node card to be the Kubernetes Node object, never a
 *             made-up `kind-control-plane`.
 * ARCHITECTURE: `nodeView` over a Node object as the API returns it; `readNodes` outside a cluster
 *   must be `ok:false` with a reason (no token mounted → unreachable), never a node.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodeView, readNodes } from '@tabs/admin/lib/cluster-nodes';

test('a Node object maps to its own name, readiness, roles, pool, allocatable and kubelet', () => {
  const v = nodeView({
    metadata: { name: 'shoot--x-pool-a-1', labels: { 'node.kubernetes.io/pool': 'pool-a', 'node-role.kubernetes.io/worker': '' } },
    status: { conditions: [{ type: 'Ready', status: 'True' }], allocatable: { cpu: '7910m', memory: '55134696Ki' }, nodeInfo: { kubeletVersion: 'v1.33.4' } },
  });
  assert.deepEqual(v, { name: 'shoot--x-pool-a-1', ready: true, roles: 'worker', pool: 'pool-a', cpu: '7910m', mem: '55134696Ki', kubelet: 'v1.33.4' });
  assert.equal(nodeView({ metadata: { name: 'n' }, status: { conditions: [{ type: 'Ready', status: 'False' }] } }).ready, false);
});

test('outside a cluster the nodes are not readable, and that is said — no node is invented', async () => {
  const r = await readNodes();
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'unreachable');
});
