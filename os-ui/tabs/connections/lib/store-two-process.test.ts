/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        connections
 * FEATURE:    An agent's connection write in the worker never overwrites a newer edit made in the web app
 * USER STORY: As a builder I rename my connection in the Connections tab while an agent (running in
 *             the worker pod) tests it or changes one capability. After the agent finishes and
 *             os-ui restarts, my rename is still there — and so is what the agent did.
 * ARCHITECTURE:
 *   - Two simulated processes over one fake OpenSearch, through the REAL store
 *     (`core/infra/two-process-fixture.ts`). A restart is an empty process that hydrates.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '@core/kernel/config';
import { fakeCluster, proc, as, type Proc } from '@core/infra/two-process-fixture';

(config as { externalConnectorsEnabled: boolean }).externalConnectorsEnabled = true;

const store = await import('@tabs/connections/lib/store');

const KEYS = [Symbol.for('soa.connections.cache')];
const INDEX = 'os-connections';
const bea = { id: 'bea', name: 'Bea', domains: ['sales'], role: 'builder' as const };

async function scenario() {
  const os = fakeCluster();
  store.__resetConnections();
  const web = proc();
  const worker = proc(true);
  const c = await as(web, KEYS, () =>
    store.createConnection(bea, { name: 'Gmail', template: 'gmail', endpoint: 'https://gmail.googleapis.com', credential: 'tok' }),
  );
  await as(worker, KEYS, () => store.listConnectionsForUser(bea)); // the worker boots: hydrates its copy
  return { os, web, worker, id: c.id, firstTool: c.tools[0]?.name };
}

async function restart(): Promise<Proc> {
  const fresh = proc();
  await as(fresh, KEYS, () => store.listConnectionsForUser(bea));
  return fresh;
}

test('an agent testing a connection in the worker keeps a rename made meanwhile in os-ui', async () => {
  const { os, web, worker, id } = await scenario();
  try {
    await as(web, KEYS, () => store.renameConnection(id, bea, 'Team inbox'));
    await as(worker, KEYS, () => store.testConnection(id, bea));

    const rebooted = await restart();
    const back = await as(rebooted, KEYS, () => store.getConnectionForUser(id, bea));
    assert.equal(back.name, 'Team inbox', 'the rename made in os-ui must survive the worker testing the connection');
  } finally {
    os.restore();
    store.__resetConnections();
  }
});

test('an agent changing a capability in the worker keeps a rename made meanwhile in os-ui', async () => {
  const { os, web, worker, id, firstTool } = await scenario();
  try {
    assert.ok(firstTool, 'the template has at least one tool');
    await as(web, KEYS, () => store.renameConnection(id, bea, 'Team inbox'));
    await as(worker, KEYS, () => store.updateCapabilities(id, bea, [{ name: firstTool!, mode: 'Blocked' }]));

    const rebooted = await restart();
    const back = await as(rebooted, KEYS, () => store.getConnectionForUser(id, bea));
    assert.equal(back.name, 'Team inbox');
    assert.equal(back.tools.find((t) => t.name === firstTool)?.mode, 'Blocked', "the agent's capability change is kept");
  } finally {
    os.restore();
    store.__resetConnections();
  }
});

test('a connection deleted in os-ui is not brought back by an agent test in the worker', async () => {
  const { os, web, worker, id } = await scenario();
  try {
    await as(web, KEYS, () => {
      store.setConnectionArchivedSync(id, bea, true);
      store.deleteConnectionSync(id, bea);
    });
    assert.equal(os.doc(INDEX, id), undefined, 'the delete reached the mirror');
    await as(worker, KEYS, () => store.testConnection(id, bea));
    assert.equal(os.doc(INDEX, id), undefined, 'the worker write must not re-create the deleted connection');
  } finally {
    os.restore();
    store.__resetConnections();
  }
});
