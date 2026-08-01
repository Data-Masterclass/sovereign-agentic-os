/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __resetStore as resetFolders } from '../folders/folder-store.ts';
import { __resetStore as resetAgents, createSystem, promoteSystem, type Principal } from './store.ts';
import { agentsAdapter } from './folder-adapter.ts';

const amir: Principal = { id: 'amir', domains: ['sales'], role: 'creator' };
const sara: Principal = { id: 'sara', domains: ['sales'], role: 'domain_admin' };
const user = { id: 'amir', role: 'creator', domains: ['sales'] };

beforeEach(() => { resetAgents(); resetFolders(); });

// A personal (Personal-visibility) system lives in the PERSONAL tree. After a move, the
// personal-scope enumeration finds it at its new path; the domain scope never does — so a
// scope-driven single-root picker can only ever offer a valid destination.
test('a moved personal system is found under its new folder in the PERSONAL scope only', () => {
  const s = createSystem(amir, { name: 'Router' });
  assert.equal(s.visibility, 'Personal', 'a fresh system is Personal');
  agentsAdapter.moveItem(s.id, user, '/ops');
  assert.deepEqual(agentsAdapter.itemsUnderFolder(user, 'personal', '/ops').map((i) => i.id), [s.id]);
  assert.deepEqual(agentsAdapter.itemsUnderFolder(user, 'domain', '/ops').map((i) => i.id), []);
});

test('a Shared system lives in the DOMAIN scope lane, not personal', () => {
  const s = createSystem(sara, { name: 'Shared Desk' });
  promoteSystem(s.id, sara); // Personal → Shared (sara is domain_admin)
  const saraUser = { id: 'sara', role: 'domain_admin', domains: ['sales'] };
  agentsAdapter.moveItem(s.id, saraUser, '/team');
  assert.deepEqual(agentsAdapter.itemsUnderFolder(saraUser, 'domain', '/team').map((i) => i.id), [s.id]);
  assert.deepEqual(agentsAdapter.itemsUnderFolder(saraUser, 'personal', '/team').map((i) => i.id), []);
});

test('agents adapter itemsUnderFolder includes ARCHIVED members for the cascade', () => {
  const s = createSystem(amir, { name: 'Temp' });
  agentsAdapter.moveItem(s.id, user, '/keep');
  agentsAdapter.archiveItem(s.id, user);
  assert.deepEqual(agentsAdapter.itemsUnderFolder(user, 'personal', '/keep').map((i) => i.id), [s.id]);
});

test('agents adapter ops are edit-scoped — a non-owner non-admin is denied 403', () => {
  const s = createSystem(amir, { name: 'Owned' });
  const stranger = { id: 'cara', role: 'creator', domains: ['sales'] };
  assert.throws(() => agentsAdapter.moveItem(s.id, stranger, '/hijack'), (e) => (e as { status?: number }).status === 403);
  assert.throws(() => agentsAdapter.archiveItem(s.id, stranger), (e) => (e as { status?: number }).status === 403);
  assert.throws(() => agentsAdapter.deleteItem(s.id, stranger), (e) => (e as { status?: number }).status === 403);
});
