/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSystem } from '../system-schema.ts';
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
