/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Tests for the Phase-4b create-new-in-App-folder + grant orchestration
 * (context-provision.ts). The pure folder-name derivation is tested directly; the
 * create-and-grant WIRING (create a governed artifact → place it in the App folder →
 * add the app grant) runs for real against the in-memory registries, offline.
 */

globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;

const { createApp, __resetAppsCache, getAppForUser } = await import('../apps.ts');
const dataStore = await import('../../data/store.ts');
const { getDataset, __resetStore } = dataStore;
const {
  appContextFolder,
  createAndGrant,
  createAgentAndGrant,
} = await import('./context-provision.ts');

const OWNER = { id: 'own', name: 'Owner', domains: ['sales'], role: 'builder', allDomains: ['sales'], activeDomain: null } as const;
const OTHER = { id: 'evil', name: 'Other', domains: ['sales'], role: 'builder', allDomains: ['sales'], activeDomain: null } as const;

beforeEach(() => {
  __resetAppsCache();
  __resetStore();
});

async function seedApp(name = 'Renewals Tracker') {
  return createApp(OWNER, { name, template: 'sovereign-app' });
}

// ---------------------------------------------------------- folder derivation --

test('appContextFolder wraps the app name in an "App «Name»" segment', () => {
  assert.equal(appContextFolder('Renewals'), '/App «Renewals»');
});

test('appContextFolder sanitises odd names into a single safe path segment', () => {
  // slashes would split the path → collapsed to spaces; extra whitespace collapsed.
  assert.equal(appContextFolder('A/B  Report'), '/App «A B Report»');
  assert.equal(appContextFolder('  Spaced  Out  '), '/App «Spaced Out»');
  // the derived path is always exactly ONE segment (never nested / escaped by slashes)
  assert.equal(appContextFolder('x/y/z').split('/').filter(Boolean).length, 1);
  assert.equal(appContextFolder('x/y/z'), '/App «x y z»');
});

test('appContextFolder falls back to "Untitled" for an empty/whitespace name', () => {
  assert.equal(appContextFolder(''), '/App «Untitled»');
  assert.equal(appContextFolder('   '), '/App «Untitled»');
});

// ---------------------------------------------------------- create + grant -----

test('create-new DATA: creates the dataset in the App folder and grants it read-only', async () => {
  const app = await seedApp('Renewals Tracker');
  const res = await createAndGrant(app.id, 'data', { name: 'Contracts' }, OWNER);

  assert.equal(res.type, 'data');
  assert.equal(res.name, 'Contracts');
  assert.equal(res.folder, '/App «Renewals Tracker»');

  // The dataset really landed in the App folder under Data.
  const ds = getDataset(res.id, OWNER);
  assert.equal(ds.folder, '/App «Renewals Tracker»', 'placed in the App folder');

  // ...and the grant was added to the app (read-only reference default).
  const after = await getAppForUser(app.id, OWNER);
  const grant = after.grants.data.find((g) => g.id === res.id);
  assert.ok(grant, 'the new dataset is granted to the app');
  assert.equal(grant!.access, 'read-only');
});

test('create-new DATA requires a name', async () => {
  const app = await seedApp();
  await assert.rejects(() => createAndGrant(app.id, 'data', { name: '  ' }, OWNER), /needs a name/);
});

test('create-and-grant is edit-scoped: a non-owner is rejected', async () => {
  const app = await seedApp();
  await assert.rejects(() => createAndGrant(app.id, 'data', { name: 'X' }, OTHER));
});

// ---------------------------------------------------------- agents grant -------

test('agents create-and-grant adds the agent id to app.grants.agents', async () => {
  const app = await seedApp();
  const res = await createAndGrant(app.id, 'agents', { agentId: 'sys_123', name: 'Triage' }, OWNER);

  assert.equal(res.type, 'agents');
  assert.equal(res.id, 'sys_123');

  const after = await getAppForUser(app.id, OWNER);
  assert.ok(after.agents.some((g) => g.id === 'sys_123'), 'the agent grant is recorded');
  assert.equal(after.agents.find((g) => g.id === 'sys_123')!.access, 'read-only');
});

test('agents create-and-grant requires an agentId', async () => {
  const app = await seedApp();
  await assert.rejects(() => createAndGrant(app.id, 'agents', { agentId: '' }, OWNER), /agentId/);
});

test('createAgentAndGrant scaffolds a fresh agent and grants it', async () => {
  const app = await seedApp();
  const res = await createAgentAndGrant(app.id, 'Renewals assistant', OWNER);
  assert.equal(res.type, 'agents');
  assert.ok(res.id.startsWith('sys'), 'a real agent id was minted');
  const after = await getAppForUser(app.id, OWNER);
  assert.ok(after.agents.some((g) => g.id === res.id), 'the freshly-created agent is granted');
});
