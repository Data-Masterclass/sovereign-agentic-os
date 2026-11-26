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
import { nodeView, readNodes, readNodeList } from '@tabs/admin/lib/cluster-nodes';
import { nodeListNotice, NODE_LIST_OFF_TEXT } from '@tabs/admin/lib/node-list-notice';

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

// Off BY CONFIG (osUI.nodesReader.enabled=false) vs on-and-refused. The two must never look alike.
test('node list off by config: the API is not called, and the page shows a grey neutral note', async () => {
  let called = 0;
  const r = await readNodeList(false, async () => { called += 1; return { status: 403, body: {} }; });
  assert.equal(called, 0);
  assert.deepEqual(r, { nodes: [], nodesOff: true, nodesError: null });
  assert.deepEqual(nodeListNotice(r), { tone: 'neutral', text: NODE_LIST_OFF_TEXT });
  assert.equal(NODE_LIST_OFF_TEXT, 'Node list is off on this install');
});

test('negative twin — node list ON and the API answers 403: a red forbidden error, never the neutral note', async () => {
  const r = await readNodeList(true, async () => ({ status: 403, body: {} }));
  assert.equal(r.nodesOff, false);
  assert.equal(r.nodesError?.reason, 'forbidden');
  const n = nodeListNotice(r);
  assert.equal(n?.tone, 'error');
  assert.match(n!.text, /^Nodes not readable \(forbidden\): os-ui may not read nodes/);
});

test('node list ON and unreachable stays red; ON and readable shows no note', async () => {
  const down = await readNodeList(true, async () => ({ status: 0, body: {} }));
  assert.equal(nodeListNotice(down)?.tone, 'error');
  const up = await readNodeList(true, async () => ({ status: 200, body: { items: [{ metadata: { name: 'n1' } }] } }));
  assert.equal(up.nodes.length, 1);
  assert.equal(nodeListNotice(up), null);
});
