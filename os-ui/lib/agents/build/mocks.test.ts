/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSystem, downgradeGrantsForRole } from '../system-schema.ts';
import { newMockBackends, registerGrants, gatewayFor } from './mocks.ts';

const SYS = `
system: { name: Conn, domain: sales, visibility: Personal }
entrypoint: assistant
grants:
  tools: [retrieve]
  connections:
    - { id: crm, capability: Read }
    - { id: crm_write, capability: Write-approval }
agents:
  - { id: assistant, role: helps, agent_md: "", memory_md: "", tools: [retrieve] }
edges: []
`;

function gw() {
  const backends = newMockBackends();
  registerGrants(backends, parseSystem(SYS));
  return gatewayFor(backends);
}

test('authorize honors the read/write flag on a connection', async () => {
  // Finding #3 — the write flag must change the decision.
  const g = gw();

  // A read-only (Read) connection: read allowed, WRITE denied.
  assert.equal((await g.authorize('p', 'connection_crm', { write: false })).effect, 'allow');
  assert.equal((await g.authorize('p', 'connection_crm', { write: true })).effect, 'deny');

  // A Write-approval connection: READ allowed, write requires approval.
  assert.equal((await g.authorize('p', 'connection_crm_write', { write: false })).effect, 'allow');
  assert.equal((await g.authorize('p', 'connection_crm_write', { write: true })).effect, 'requires_approval');

  // A non-granted connection is denied either way.
  assert.equal((await g.authorize('p', 'connection_ghost', { write: false })).effect, 'deny');

  // Plain tool grants are unaffected.
  assert.equal((await g.authorize('p', 'retrieve')).effect, 'allow');
});

const ARTIFACTS = `
system: { name: Art, domain: sales, visibility: Personal }
entrypoint: assistant
grants:
  tools: []
  data:
    - { id: sales.orders, capability: Read }
    - { id: sales.margin, capability: Write-approval }
  knowledge:
    - { id: onboarding, capability: Read }
  metrics:
    - { id: sales.orders.count, capability: Write-bounded }
agents:
  - { id: assistant, role: helps, agent_md: "", memory_md: "" }
edges: []
`;

test('registerGrants wires data/knowledge/metric capabilities through the SAME gateway semantics', async () => {
  const backends = newMockBackends();
  registerGrants(backends, parseSystem(ARTIFACTS));
  const g = gatewayFor(backends);

  // Read grant → read allowed, write denied.
  assert.equal((await g.authorize('p', 'data_sales.orders', { write: false })).effect, 'allow');
  assert.equal((await g.authorize('p', 'data_sales.orders', { write: true })).effect, 'deny');

  // Write-approval grant → write is HELD for approval (Governance queue).
  assert.equal((await g.authorize('p', 'data_sales.margin', { write: true })).effect, 'requires_approval');

  // Knowledge read grant → allowed.
  assert.equal((await g.authorize('p', 'knowledge_onboarding', { write: false })).effect, 'allow');

  // Write-bounded metric → direct write allowed (builder-gated at save time).
  assert.equal((await g.authorize('p', 'metric_sales.orders.count', { write: true })).effect, 'allow');

  // A metric that was never granted is denied.
  assert.equal((await g.authorize('p', 'metric_ghost', { write: false })).effect, 'deny');
});

// S-A: the Probe route governs grants before probing (probeConnection = registerGrants
// + gatewayFor over the GOVERNED system). Proven here via the same internals: a
// demoted owner's stale Write-bounded connection probes as held, not direct allow.
const DIRECT_CONN = `
system: { name: Prb, domain: sales, visibility: Personal }
entrypoint: assistant
grants:
  tools: []
  connections:
    - { id: erp, capability: Write-bounded }
agents:
  - { id: assistant, role: helps, agent_md: "", memory_md: "" }
edges: []
`;

test('S-A: probing GOVERNED grants — a demoted owner’s Write-bounded connection write is held, not direct-allowed', async () => {
  const sys = parseSystem(DIRECT_CONN);

  // Ungoverned (owner still builder+): a write probe is a DIRECT allow.
  const b1 = newMockBackends();
  registerGrants(b1, sys);
  const raw = await gatewayFor(b1).authorize('probe', 'connection_erp', { write: true });
  assert.equal(raw.effect, 'allow');

  // Governed for a demoted (creator) owner: the SAME write probe is held for approval.
  const b2 = newMockBackends();
  registerGrants(b2, downgradeGrantsForRole(sys, 'creator'));
  const governed = await gatewayFor(b2).authorize('probe', 'connection_erp', { write: true });
  assert.equal(governed.effect, 'requires_approval');
});
