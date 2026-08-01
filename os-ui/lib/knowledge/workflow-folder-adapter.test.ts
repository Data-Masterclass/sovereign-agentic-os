/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __resetStore as resetFolders } from '../folders/folder-store.ts';
import { __resetStore as resetKnowledge, createWorkflow, publishWorkflow, type Principal } from './store.ts';
import { workflowAdapter } from './workflow-folder-adapter.ts';

const amir: Principal = { id: 'amir', domains: ['sales'], role: 'creator' };
const dom: Principal = { id: 'dana', domains: ['sales'], role: 'domain_admin' };
const admin: Principal = { id: 'sara', domains: ['sales', 'finance'], role: 'admin' };
const outsider = { id: 'kenji', role: 'builder', domains: ['finance'] };
const user = { id: 'amir', role: 'creator', domains: ['sales'] };

beforeEach(() => { resetKnowledge(); resetFolders(); });

// A Personal draft lives in the PERSONAL lane; the domain lane never sees it (same
// scope-lane discipline as Data/Knowledge — no cross-tier cascade leak).
test('a moved Personal workflow is found in the PERSONAL scope only', () => {
  const wf = createWorkflow(amir, { title: 'Bank Submission', domain: 'sales' });
  workflowAdapter.moveItem(wf.id, user, '/contracts');
  assert.deepEqual(
    workflowAdapter.itemsUnderFolder(user, 'personal', '/contracts').map((i) => i.id),
    [wf.id],
  );
  assert.deepEqual(workflowAdapter.itemsUnderFolder(user, 'domain', '/contracts').map((i) => i.id), []);
});

test('a Shared workflow lives in the DOMAIN lane, not personal', () => {
  const wf = createWorkflow(amir, { title: 'Onboarding', domain: 'sales' });
  publishWorkflow(wf.id, dom); // Personal → Shared
  workflowAdapter.moveItem(wf.id, admin, '/ops');
  assert.deepEqual(workflowAdapter.itemsUnderFolder(admin, 'domain', '/ops').map((i) => i.id), [wf.id]);
  assert.deepEqual(workflowAdapter.itemsUnderFolder(admin, 'personal', '/ops').map((i) => i.id), []);
});

test('itemsUnderFolder includes ARCHIVED members for the restore/delete cascade', () => {
  const wf = createWorkflow(amir, { title: 'Draft', domain: 'sales' });
  workflowAdapter.moveItem(wf.id, user, '/keep');
  workflowAdapter.archiveItem(wf.id, user);
  assert.deepEqual(workflowAdapter.itemsUnderFolder(user, 'personal', '/keep').map((i) => i.id), [wf.id]);
});

test('adapter ops are edit-scoped: a non-owner non-admin is denied 403', () => {
  const wf = createWorkflow(amir, { title: 'Private', domain: 'sales' });
  assert.throws(() => workflowAdapter.moveItem(wf.id, outsider, '/x'), (e) => (e as { status?: number }).status === 403);
  assert.throws(() => workflowAdapter.archiveItem(wf.id, outsider), (e) => (e as { status?: number }).status === 403);
});

test('archive → restore round-trips, then delete removes it (edit-scoped)', () => {
  const wf = createWorkflow(amir, { title: 'Lifecycle', domain: 'sales' });
  workflowAdapter.moveItem(wf.id, user, '/keep');
  workflowAdapter.archiveItem(wf.id, user);
  workflowAdapter.restoreItem(wf.id, user);
  assert.deepEqual(workflowAdapter.itemsUnderFolder(user, 'personal', '/keep').map((i) => i.id), [wf.id]);
  workflowAdapter.deleteItem(wf.id, user);
  assert.deepEqual(workflowAdapter.itemsUnderFolder(user, 'personal', '/keep').map((i) => i.id), []);
});
