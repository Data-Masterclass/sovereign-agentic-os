/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    An agent's app write in the worker never overwrites a newer edit made in the web app
 * USER STORY: As a creator I rename my app in the Software tab while an agent (running in the
 *             worker pod) sets its design or spec. After the agent finishes and os-ui restarts,
 *             my rename is still there — and so is what the agent did.
 * ARCHITECTURE:
 *   - Two simulated processes over one fake OpenSearch, through the REAL store
 *     (`core/infra/two-process-fixture.ts`). A restart is an empty process that hydrates.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeCluster, proc, as, type Proc } from '@core/infra/two-process-fixture';
import * as apps from '@tabs/software/lib/apps';

const KEYS = [Symbol.for('soa.apps.cache')];
const bea = { id: 'bea', name: 'Bea', domains: ['sales'], role: 'builder' as const };

async function scenario() {
  const os = fakeCluster();
  apps.__resetAppsCache();
  const web = proc();
  const worker = proc(true);
  const app = await as(web, KEYS, () => apps.createApp(bea, { name: 'Returns desk', template: 'sovereign-app' }));
  await as(worker, KEYS, () => apps.listAppsForUser(bea)); // the worker boots: hydrates its copy
  return { os, web, worker, id: app.id };
}

async function restart(): Promise<Proc> {
  const fresh = proc();
  await as(fresh, KEYS, () => apps.listAppsForUser(bea));
  return fresh;
}

test('an agent setting the app design in the worker keeps a rename made meanwhile in os-ui', async () => {
  const { os, web, worker, id } = await scenario();
  try {
    await as(web, KEYS, () => apps.renameApp(id, bea, 'Returns desk v2'));
    await as(worker, KEYS, () => apps.patchAppDesign(id, bea, { purpose: 'Handle returns in one place.' }));

    const rebooted = await restart();
    const back = await as(rebooted, KEYS, () => apps.getAppForUser(id, bea));
    assert.equal(back.name, 'Returns desk v2', 'the rename made in os-ui must survive the worker setting the design');
    assert.equal(back.purpose, 'Handle returns in one place.', "the agent's design is kept");
  } finally {
    os.restore();
    apps.__resetAppsCache();
  }
});

test('an app created in os-ui after the worker booted is read from the mirror and written by its fields only', async () => {
  const { os, web, worker } = await scenario();
  try {
    const late = await as(web, KEYS, () => apps.createApp(bea, { name: 'Late app', template: 'sovereign-app' }));
    await as(web, KEYS, () => apps.renameApp(late.id, bea, 'Late app (renamed)'));
    await as(worker, KEYS, () => apps.patchAppDesign(late.id, bea, { purpose: 'Created after boot.' }));

    const rebooted = await restart();
    const back = await as(rebooted, KEYS, () => apps.getAppForUser(late.id, bea));
    assert.equal(back.name, 'Late app (renamed)');
    assert.equal(back.purpose, 'Created after boot.');
  } finally {
    os.restore();
    apps.__resetAppsCache();
  }
});

test('an app deleted in os-ui is not brought back by an agent write in the worker', async () => {
  const { os, web, worker, id } = await scenario();
  try {
    await as(web, KEYS, () => apps.removeAppInternal(id));
    await as(worker, KEYS, async () => {
      try {
        await apps.patchAppDesign(id, bea, { purpose: 'Too late.' });
      } catch {
        /* refusing the write is also correct */
      }
    });
    const rebooted = await restart();
    const back = await as(rebooted, KEYS, () => apps.getAppByIdInternal(id));
    assert.equal(back, null, 'the worker write must not re-create the deleted app');
  } finally {
    os.restore();
    apps.__resetAppsCache();
  }
});
