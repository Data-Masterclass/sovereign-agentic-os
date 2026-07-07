/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  __resetStore,
  listWorkflows,
  getWorkflow,
  createWorkflow,
  updateWorkflow,
  deleteWorkflow,
  publishWorkflow,
  certifyWorkflow,
  getDomainKnowledge,
  updateDomainKnowledge,
  archiveWorkflow,
  unarchiveWorkflow,
  listWorkflowVersions,
  restoreWorkflowVersion,
  sha,
} from './store.ts';

const participant = { id: 'amir', domains: ['sales'], role: 'creator' as const };
const builder = { id: 'bea', domains: ['sales'], role: 'builder' as const };
const admin = { id: 'sara', domains: ['sales', 'finance'], role: 'admin' as const };
const outsider = { id: 'kenji', domains: ['finance'], role: 'builder' as const };

test('a fresh tenant has no workflows', () => {
  __resetStore();
  const groups = listWorkflows(participant);
  assert.equal(groups.mine.length, 0);
  assert.equal(groups.domain.length, 0);
  assert.equal(groups.marketplace.length, 0);
});

test('a created draft appears under Mine for its owner', () => {
  __resetStore();
  createWorkflow(participant, { title: 'Bank Submission', domain: 'sales' });
  const groups = listWorkflows(participant);
  assert.ok(groups.mine.some((w) => w.title === 'Bank Submission'));
});

test('a published workflow is visible to its domain', () => {
  __resetStore();
  const rec = createWorkflow(builder, { title: 'Customer Onboarding', domain: 'sales' });
  publishWorkflow(rec.id, builder);
  const groups = listWorkflows(builder);
  const all = [...groups.mine, ...groups.domain, ...groups.marketplace];
  assert.ok(all.some((w) => w.title === 'Customer Onboarding'), 'Customer Onboarding should be visible');
});

test('outsider from another domain cannot see Personal drafts', () => {
  __resetStore();
  createWorkflow(participant, { title: 'Bank Submission', domain: 'sales' });
  const groups = listWorkflows(outsider);
  const all = [...groups.mine, ...groups.domain, ...groups.marketplace];
  assert.ok(!all.some((w) => w.title === 'Bank Submission'), 'Bank Submission should not be visible to outsider');
});

test('create → appears under Mine for the creator', () => {
  __resetStore();
  const rec = createWorkflow(participant, { title: 'Invoice Reconciliation', domain: 'sales' });
  assert.equal(rec.status, 'draft');
  assert.equal(rec.visibility, 'Personal');
  const groups = listWorkflows(participant);
  assert.ok(groups.mine.some((w) => w.id === rec.id));
});

test('getWorkflow returns parsed workflow with steps', () => {
  __resetStore();
  const rec = createWorkflow(builder, { title: 'Test', domain: 'sales' });
  const view = getWorkflow(rec.id, builder);
  assert.equal(view.workflow.title, 'Test');
  assert.ok(Array.isArray(view.workflow.steps));
});

test('updateWorkflow accepts valid markdown and updates title', () => {
  __resetStore();
  const rec = createWorkflow(builder, { title: 'Old', domain: 'sales' });
  const currentSha = sha(getWorkflow(rec.id, builder).md);
  const newMd = getWorkflow(rec.id, builder).md.replace('title: Old', 'title: New Title');
  const updated = updateWorkflow(rec.id, builder, { md: newMd, sha: currentSha });
  assert.equal(updated.title, 'New Title');
});

test('updateWorkflow rejects a stale sha', () => {
  __resetStore();
  const rec = createWorkflow(builder, { title: 'Stale', domain: 'sales' });
  const view = getWorkflow(rec.id, builder);
  const staleSha = sha(view.md);
  // Mutate the record to make sha stale.
  updateWorkflow(rec.id, builder, { md: view.md + '\n', sha: staleSha });
  assert.throws(
    () => updateWorkflow(rec.id, builder, { md: view.md + '\n#edit2', sha: staleSha }),
    /stale/i,
  );
});

test('participant CANNOT publish (publish gate)', () => {
  __resetStore();
  const draft = createWorkflow(participant, { title: 'Draft', domain: 'sales' });
  assert.equal(draft.status, 'draft');
  assert.throws(() => publishWorkflow(draft.id, participant), /builder|admin/i);
});

test('builder CAN publish: draft → live (Personal → Shared)', () => {
  __resetStore();
  const rec = createWorkflow(builder, { title: 'To Publish', domain: 'sales' });
  assert.equal(rec.status, 'draft');
  const published = publishWorkflow(rec.id, builder);
  assert.equal(published.status, 'live');
  assert.equal(published.visibility, 'Shared');
  assert.ok(published.publishedBy === builder.id);
});

test('cannot publish an already-live workflow', () => {
  __resetStore();
  const rec = createWorkflow(builder, { title: 'Double-publish', domain: 'sales' });
  publishWorkflow(rec.id, builder);
  assert.throws(() => publishWorkflow(rec.id, builder), /already published/i);
});

test('only admin can certify to Marketplace', () => {
  __resetStore();
  const rec = createWorkflow(builder, { title: 'For Market', domain: 'sales' });
  publishWorkflow(rec.id, builder);
  assert.throws(() => certifyWorkflow(rec.id, builder), /admin/i);
  const certified = certifyWorkflow(rec.id, admin);
  assert.equal(certified.visibility, 'Marketplace');
});

test('delete removes a draft', () => {
  __resetStore();
  const rec = createWorkflow(participant, { title: 'Delete Me', domain: 'sales' });
  deleteWorkflow(rec.id, participant);
  const groups = listWorkflows(participant);
  assert.ok(!groups.mine.some((w) => w.id === rec.id));
});

test('cannot delete a live workflow', () => {
  __resetStore();
  const rec = createWorkflow(builder, { title: 'Published', domain: 'sales' });
  publishWorkflow(rec.id, builder);
  assert.throws(() => deleteWorkflow(rec.id, builder), /unpublish/i);
});

test('getDomainKnowledge returns the empty domain-knowledge template (4 sections)', () => {
  __resetStore();
  const dk = getDomainKnowledge('sales');
  assert.equal(dk.domain, 'sales');
  assert.equal(dk.sections.length, 4);
  // The section TEMPLATE is structural; a fresh tenant has no content yet.
  assert.equal(dk.sections.find((s) => s.id === 'overview')?.content, '');
});

test('updateDomainKnowledge patches section content', () => {
  __resetStore();
  updateDomainKnowledge('sales', builder, {
    sections: [{ id: 'overview', content: 'Updated overview.' }],
  });
  const dk = getDomainKnowledge('sales');
  assert.equal(dk.sections.find((s) => s.id === 'overview')?.content, 'Updated overview.');
});

test('outsider cannot update domain knowledge', () => {
  __resetStore();
  assert.throws(
    () => updateDomainKnowledge('sales', outsider, { sections: [{ id: 'overview', content: 'x' }] }),
    /permitted/i,
  );
});

// ------------------------------------------ archive / delete / versions -------

test('updateWorkflow snapshots the prior source; restore reverts + is itself versioned', () => {
  __resetStore();
  const rec = createWorkflow(builder, { title: 'Versioned', domain: 'sales' });
  assert.equal(listWorkflowVersions(rec.id, builder).length, 0, 'no history before first edit');

  const view0 = getWorkflow(rec.id, builder);
  const edit1 = view0.md + '\n<!-- edit-1 -->';
  updateWorkflow(rec.id, builder, { md: edit1, sha: view0.sha });
  const view1 = getWorkflow(rec.id, builder);
  const edit2 = edit1 + '\n<!-- edit-2 -->';
  updateWorkflow(rec.id, builder, { md: edit2, sha: view1.sha });

  const history = listWorkflowVersions(rec.id, builder);
  assert.equal(history.length, 2);
  assert.equal(history[0].version, 2, 'newest first');
  assert.equal(history[0].author, builder.id);
  assert.equal(history[1].version, 1);

  // A no-op save does NOT churn a new version.
  updateWorkflow(rec.id, builder, { md: edit2, sha: getWorkflow(rec.id, builder).sha });
  assert.equal(listWorkflowVersions(rec.id, builder).length, 2);

  // Restore v1 (the first edit's prior = original) → md reverts AND the
  // pre-restore state is snapshotted as v3, so restore is auditable + reversible.
  restoreWorkflowVersion(rec.id, builder, 1);
  assert.equal(getWorkflow(rec.id, builder).md, view0.md);
  const after = listWorkflowVersions(rec.id, builder);
  assert.equal(after.length, 3);
  assert.equal(after[0].version, 3);
  assert.match(after[0].summary, /restore of v1/);

  // Restoring an unknown version 404s.
  assert.throws(() => restoreWorkflowVersion(rec.id, builder, 99), /not found/i);
});

test('archive hides from working list; unarchive restores it', () => {
  __resetStore();
  const rec = createWorkflow(builder, { title: 'Archivable', domain: 'sales' });

  archiveWorkflow(rec.id, builder);
  assert.equal(getWorkflow(rec.id, builder).archived, true);
  // Hidden from the default working list, visible with includeArchived.
  assert.ok(!listWorkflows(builder).mine.some((w) => w.id === rec.id));
  assert.ok(listWorkflows(builder, { includeArchived: true }).mine.some((w) => w.id === rec.id));

  unarchiveWorkflow(rec.id, builder);
  assert.equal(getWorkflow(rec.id, builder).archived, false);
  assert.ok(listWorkflows(builder).mine.some((w) => w.id === rec.id));
});

test('delete purges version history (hard delete)', () => {
  __resetStore();
  const rec = createWorkflow(builder, { title: 'Deletable', domain: 'sales' });
  const view0 = getWorkflow(rec.id, builder);
  updateWorkflow(rec.id, builder, { md: view0.md + '\n<!-- e -->', sha: view0.sha });
  assert.equal(listWorkflowVersions(rec.id, builder).length, 1);

  deleteWorkflow(rec.id, builder);
  assert.throws(() => getWorkflow(rec.id, builder), /not found/i);

  // A fresh workflow has no leaked history (purge worked).
  const fresh = createWorkflow(builder, { title: 'Fresh', domain: 'sales' });
  assert.equal(listWorkflowVersions(fresh.id, builder).length, 0);
});

test('archive / delete / restore obey edit authz (viewer is rejected 403)', () => {
  __resetStore();
  // A published workflow is Shared → visible to same-domain participants.
  const rec = createWorkflow(builder, { title: 'Governed', domain: 'sales' });
  publishWorkflow(rec.id, builder); // now Shared(live)
  const view0 = getWorkflow(rec.id, builder);
  updateWorkflow(rec.id, builder, { md: view0.md + '\n<!-- e -->', sha: view0.sha });

  // participant (creator, sales) can VIEW history but NOT edit/archive/restore.
  assert.doesNotThrow(() => listWorkflowVersions(rec.id, participant));
  assert.throws(() => archiveWorkflow(rec.id, participant), /not permitted to edit/i);
  assert.throws(() => restoreWorkflowVersion(rec.id, participant, 1), /not permitted to edit/i);

  // Same-domain admin (builder+) may archive.
  assert.doesNotThrow(() => archiveWorkflow(rec.id, admin));
});

test('cross-instance: workflow writes are visible through globalThis symbol', () => {
  __resetStore();
  const rec = createWorkflow(participant, { title: 'CI Workflow', domain: 'sales' });
  const raw = (globalThis as Record<symbol, unknown>)[Symbol.for('soa.knowledge.store')] as { workflows: Map<string, unknown> };
  assert.ok(raw && raw.workflows.has(rec.id), 'record visible in globalThis state');
  assert.equal(listWorkflows(participant).mine.length, 1);
});
