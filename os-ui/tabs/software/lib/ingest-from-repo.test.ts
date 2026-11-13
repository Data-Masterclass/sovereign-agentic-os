/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    `ingestFromRepo('app', files)` — the registry re-derived from a push (D29)
 * USER STORY: As an engineer pushing from VS Code I want the registry to end up in the SAME state
 *             as if I had used the MCP — the coin test.
 * ARCHITECTURE: Offline (fetch rejects ⇒ the app store is in memory); the real app store, the real
 *             metadata parse. A push NEVER creates an app: that is asserted, not assumed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@core/kernel/auth';
import { testUser } from '@core/testing/user';

const _realFetch = globalThis.fetch;
globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;

const { createApp } = await import('./apps.ts');
const { ingestFromRepo, appTreesIn } = await import('./ingest-from-repo.ts');
const { getSnapshot } = await import('./file-mirror.ts');

const dev: CurrentUser = testUser({ id: 'dan', name: 'Dan', domains: ['eng'], role: 'builder' });
const outsider: CurrentUser = testUser({ id: 'zed', name: 'Zed', domains: ['sales'], role: 'builder' });

test('appTreesIn: groups by slug, strips the prefix, ignores everything outside apps/', () => {
  const trees = appTreesIn([
    { path: 'apps/invoices/app.yaml', content: 'a' },
    { path: 'apps/invoices/src/App.tsx', content: 'b' },
    { path: 'apps/reports/app.yaml', content: 'c' },
    { path: 'models/semantic/x.yml', content: 'd' },
    { path: 'apps/nofile', content: 'e' },
    { path: 'agents/team/system.yaml', content: 'f' },
  ]);
  assert.deepEqual([...trees.keys()].sort(), ['invoices', 'reports']);
  assert.deepEqual(trees.get('invoices')!.map((f) => f.path).sort(), ['app.yaml', 'src/App.tsx']);
});

test('ingestFromRepo: an existing app is RE-DERIVED from the pushed files', async () => {
  const app = await createApp(dev, { name: 'Ingested', template: 'sovereign-app' });
  const out = await ingestFromRepo(
    'app',
    [
      { path: `apps/${app.slug}/app.yaml`, content: `name: Ingested\nsurface: api\ndeclares:\n  connections: []\n  data: []\n  knowledge: []\n` },
      { path: `apps/${app.slug}/actions.yml`, content: 'actions:\n  - name: Bad-Name\n    scopes: [records]\n' },
    ],
    dev,
  );
  assert.equal(out.kind, 'app');
  assert.equal(out.apps.length, 1);
  assert.equal(out.apps[0].outcome, 'updated');
  assert.equal(out.apps[0].appId, app.id);
  // The read cache follows the files (git is the home of record).
  assert.deepEqual(getSnapshot(app.id)!.map((f) => f.path).sort(), ['actions.yml', 'app.yaml']);
  // A malformed declared action is REPORTED, never silently dropped.
  assert.equal(out.apps[0].actionIssues!.length, 1);
  assert.match(out.apps[0].actionIssues![0].reason, /not a valid action name/);
});

test('ingestFromRepo: a push NEVER creates an app — it says what to do instead', async () => {
  const out = await ingestFromRepo('app', [{ path: 'apps/ghost/app.yaml', content: 'name: Ghost\n' }], dev);
  assert.equal(out.apps[0].outcome, 'unmatched');
  assert.equal(out.apps[0].appId, null);
  assert.match(String(out.apps[0].reason), /does not create an app/);
  assert.match(String(out.apps[0].reason), /create_software/, 'it names the governed way in');
});

test('ingestFromRepo: a pusher outside the app’s domain ingests NOTHING', async () => {
  const app = await createApp(dev, { name: 'Other Domain', template: 'sovereign-app' });
  const out = await ingestFromRepo('app', [{ path: `apps/${app.slug}/app.yaml`, content: 'name: Hacked\n' }], outsider);
  assert.equal(out.apps[0].outcome, 'unmatched');
  assert.match(String(out.apps[0].reason), /a domain you are not in/);
});

test('ingestFromRepo: an unknown kind is an empty result, never a throw', async () => {
  assert.deepEqual(await ingestFromRepo('dataset' as 'app', [{ path: 'x', content: '' }], dev), { kind: 'dataset', apps: [] });
  globalThis.fetch = _realFetch;
});
