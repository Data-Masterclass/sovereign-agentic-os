/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        knowledge
 * FEATURE:    WP-50 review — the git read-back is complete-or-nothing, create-only, and text-only
 * USER STORY: As an operator I never want a restart to destroy knowledge: if the store could not be
 *             read in full, the git rebuild must do nothing (the store-hydration incident class);
 *             a record git restores is CREATED only, never written over an existing document; and
 *             git restores TEXT only — scope, status, owner, publication and certification always
 *             come from the store and its approval flow.
 * ARCHITECTURE: the real store over the shared fake OpenSearch (`two-process-fixture`) and a real
 *             temp git repo. Negative twins: an unreachable and a truncated mirror; a commit that
 *             claims `Marketplace`, `live` and another owner.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '@core/kernel/config';
import { fakeCluster, settle } from '@core/infra/two-process-fixture';
import { awaitKnowledgeCommits, commitKnowledge, __setKnowledgeGitForTests } from '@tabs/knowledge/lib/git/commit';
import * as store from '@tabs/knowledge/lib/store';
import { workflowRecord, WF_MD } from '@tabs/knowledge/lib/git/fixtures';

const INDEX = 'os-knowledge-records';
const ADMIN = { id: 'lead@example.com', domains: ['sales'], role: 'domain_admin' as const };
const FUTURE = () => Math.floor(Date.now() / 1000) + 3600;

/** A full OS record as the mirror holds it, with the governed fields git must never touch. */
function storedDoc(over: Record<string, unknown> = {}) {
  return {
    ...workflowRecord({ updatedAt: '2026-01-01T00:00:00.000Z' }),
    publishedAt: '2026-01-02T00:00:00.000Z',
    publishedBy: 'lead@example.com',
    certifiedAt: null,
    certifiedBy: null,
    links: { datasets: ['ds_1'], metrics: [] },
    ...over,
  };
}

async function freshRepo(): Promise<void> {
  (config as { reposDir: string }).reposDir = mkdtempSync(join(tmpdir(), 'os-knowledge-reconcile-'));
}

async function commitBundle(workflows: Parameters<typeof commitKnowledge>[3]['captured']['workflows'], manual: Parameters<typeof commitKnowledge>[3]['captured']['manual'] = null) {
  const r = await commitKnowledge('sales', { id: 'other@example.com' }, { action: 'edit workflow' }, {
    reposDir: config.reposDir, mirror: false, captured: { workflows, manual }, timestamp: FUTURE(),
  });
  assert.ok(r?.changed);
}

for (const mode of ['down', 'truncated'] as const) {
  test(`NEGATIVE: a ${mode} mirror → the git rebuild does NOTHING and the OpenSearch doc stays byte-identical`, async () => {
    __setKnowledgeGitForTests(true);
    const os = fakeCluster();
    try {
      await freshRepo();
      const doc = storedDoc();
      os.put(INDEX, doc.id, doc);
      os.put(INDEX, 'wf_other', storedDoc({ id: 'wf_other', title: 'Other' }));
      await commitBundle([workflowRecord({ md: WF_MD.replace('Submit the monthly pack', 'Changed in git') })]);
      store.__resetStore();
      os.mode = mode;
      const errors: string[] = [];
      const orig = console.error;
      console.error = (...a: unknown[]) => { errors.push(a.join(' ')); };
      let report;
      try {
        report = await store.reconcileKnowledgeFromGit(['sales']);
      } finally {
        console.error = orig;
      }
      await settle();
      assert.deepEqual(report, []);
      assert.ok(errors.some((e) => /knowledge-git.*NOT run.*incomplete/i.test(e)), errors.join('\n'));
      assert.equal(JSON.stringify(os.doc(INDEX, doc.id)), JSON.stringify(doc), 'the real document is untouched');
      assert.ok(!os.calls.some((c) => /^(PUT|POST) \/os-knowledge-records\/_(doc|update|create)\//.test(c)), os.calls.join('\n'));
    } finally {
      os.restore();
      __setKnowledgeGitForTests(null);
    }
  });
}

test('a COMPLETE hydration: a record missing from the store is restored CREATE-ONLY, as a Personal draft', async () => {
  __setKnowledgeGitForTests(true);
  const os = fakeCluster();
  try {
    await freshRepo();
    await commitBundle([workflowRecord()]);
    store.__resetStore();
    os.put(INDEX, 'wf_unrelated', storedDoc({ id: 'wf_unrelated', title: 'Unrelated' })); // the index exists
    const report = await store.reconcileKnowledgeFromGit(['sales']);
    await settle();
    assert.equal(report.length, 1);
    assert.ok(os.calls.some((c) => c === 'PUT /os-knowledge-records/_create/wf_bank'), os.calls.join('\n'));
    const created = os.doc(INDEX, 'wf_bank') as Record<string, unknown>;
    assert.equal(created.visibility, 'Personal', 'git never grants an audience');
    assert.equal(created.status, 'draft');
    assert.equal(created.publishedAt, null);
    assert.match(String(created.md), /Submit the monthly pack/);
    assert.match(String(created.md), /visibility: Personal/);
  } finally {
    os.restore();
    __setKnowledgeGitForTests(null);
  }
});

test('create-only: a doc that appears in OpenSearch meanwhile is NOT overwritten (409 → kept)', async () => {
  __setKnowledgeGitForTests(true);
  const os = fakeCluster();
  try {
    await freshRepo();
    await commitBundle([workflowRecord()]);
    store.__resetStore();
    os.put(INDEX, 'wf_unrelated', storedDoc({ id: 'wf_unrelated' }));
    await store.ensureHydrated();
    const real = storedDoc({ certifiedBy: 'admin@example.com', certifiedAt: '2026-01-03T00:00:00.000Z' });
    os.put(INDEX, real.id, real); // written by another process after this one hydrated
    await store.reconcileKnowledgeFromGit(['sales']);
    await settle();
    assert.equal(JSON.stringify(os.doc(INDEX, real.id)), JSON.stringify(real));
  } finally {
    os.restore();
    __setKnowledgeGitForTests(null);
  }
});

test('GOVERNANCE TWIN: a commit claiming Marketplace, live and another owner changes ONLY the text', async () => {
  __setKnowledgeGitForTests(true);
  const os = fakeCluster();
  try {
    await freshRepo();
    const held = storedDoc({ status: 'draft', visibility: 'Shared', md: WF_MD.replace('status: live', 'status: draft') });
    os.put(INDEX, held.id, held);
    // The committed file says: certified audience, live, owned by mallory — and new text.
    await commitBundle([workflowRecord({
      visibility: 'Marketplace', status: 'live', owner: 'mallory@example.com',
      md: WF_MD.replace('visibility: Shared', 'visibility: Marketplace').replace('Submit the monthly pack', 'Pushed text'),
    })]);
    store.__resetStore();
    await store.reconcileKnowledgeFromGit(['sales']);
    await settle();
    const after = os.doc(INDEX, held.id) as Record<string, unknown>;
    assert.equal(after.visibility, 'Shared');
    assert.equal(after.status, 'draft');
    assert.equal(after.owner, held.owner);
    assert.equal(after.publishedAt, held.publishedAt);
    assert.equal(after.publishedBy, held.publishedBy);
    assert.equal(after.certifiedBy, null);
    assert.deepEqual(after.links, held.links);
    assert.match(String(after.md), /Pushed text/, 'the text is restored');
    assert.match(String(after.md), /visibility: Shared/, 'the md frontmatter keeps the store’s audience');
    assert.match(String(after.md), /status: draft/);
    const rec = store.getWorkflow(held.id, ADMIN);
    assert.equal(rec.visibility, 'Shared');
    assert.equal(rec.owner, held.owner);
  } finally {
    os.restore();
    __setKnowledgeGitForTests(null);
  }
});

test('the manual is text: restored from git after a COMPLETE hydration', async () => {
  __setKnowledgeGitForTests(true);
  const os = fakeCluster();
  try {
    await freshRepo();
    await commitBundle([], { domain: 'sales', sections: [{ id: 'general', title: 'General', content: 'From git.' }], updatedAt: '2026-01-01T00:00:00.000Z' });
    store.__resetStore();
    os.put(INDEX, 'wf_unrelated', storedDoc({ id: 'wf_unrelated' }));
    await store.reconcileKnowledgeFromGit(['sales']);
    await awaitKnowledgeCommits();
    assert.equal(store.getManual('domain', ADMIN, 'sales').sections.find((s) => s.id === 'general')?.content, 'From git.');
  } finally {
    os.restore();
    __setKnowledgeGitForTests(null);
  }
});
