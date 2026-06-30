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
  sha,
} from './store.ts';

const participant = { id: 'amir', domains: ['sales'], role: 'participant' as const };
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
