/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        knowledge
 * FEATURE:    WP-50 — knowledge saves commit the OKF bundle; git is read back on hydrate
 * USER STORY: As a domain member I want a published workflow and the domain's operating manual to
 *             survive a restart because they are committed to the domain repository, and I want
 *             the store to be rebuilt FROM git, so the repository is the source of truth (A21).
 * ARCHITECTURE: node:test against the real module (and a real temp git repo where it commits); no mocks.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '@core/kernel/config';
import { log, readBlob } from '@core/infra/git-store';
import { awaitKnowledgeCommits, commitKnowledge, readKnowledgeFromGit, __setKnowledgeGitForTests } from '@tabs/knowledge/lib/git/commit';
import {
  __resetStore, createWorkflow, getManual, getWorkflow, publishWorkflow, reconcileKnowledgeFromGit, updateManual, updateWorkflow,
} from '@tabs/knowledge/lib/store';

(config as { reposDir: string }).reposDir = mkdtempSync(join(tmpdir(), 'os-knowledge-git-'));
const ADMIN = { id: 'lead@example.com', name: 'Lead', domains: ['sales'], role: 'domain_admin' as const };

test('publish + manual edit commit knowledge/** as the actor; a restart rebuilds both FROM git', async () => {
  __setKnowledgeGitForTests(true);
  try {
    __resetStore();
    const wf = createWorkflow(ADMIN, { title: 'Bank Submission', domain: 'sales' });
    await awaitKnowledgeCommits();
    // A Personal draft is My scope: nothing reaches the domain repository.
    assert.equal((await log('sales', { reposDir: config.reposDir }).catch(() => [])).length, 0);

    publishWorkflow(wf.id, ADMIN);
    updateManual('domain', ADMIN, { sections: [{ id: 'general', content: 'We sell to banks.' }] }, 'sales');
    await awaitKnowledgeCommits();

    const [head] = await log('sales', { reposDir: config.reposDir, limit: 1 });
    assert.match(head.message, /^knowledge\(sales\): /);
    assert.equal(head.trailers['OS-Actor'], ADMIN.id);
    const md = await readBlob('sales', head.sha, 'knowledge/workflows/bank-submission/workflow.md', { reposDir: config.reposDir });
    assert.match(md, /^type: Workflow$/m);
    const manualMd = await readBlob('sales', head.sha, 'knowledge/manual/domain.md', { reposDir: config.reposDir });
    assert.match(manualMd, /We sell to banks\./);

    const bundle = await readKnowledgeFromGit('sales', { reposDir: config.reposDir });
    assert.equal(bundle.sha, head.sha);
    assert.equal(bundle.workflows[0].id, wf.id);

    // RESTART: the in-memory store is gone (the manual never had any other persistence).
    __resetStore();
    assert.equal(getManual('domain', ADMIN, 'sales').sections.find((s) => s.id === 'general')?.content, '');
    const report = await reconcileKnowledgeFromGit(['sales']);
    assert.deepEqual(report, [{ domain: 'sales', sha: head.sha, workflows: 1, manual: true }]);
    assert.equal(getWorkflow(wf.id, ADMIN).title, 'Bank Submission');
    assert.equal(getWorkflow(wf.id, ADMIN).visibility, 'Shared');
    assert.equal(getManual('domain', ADMIN, 'sales').sections.find((s) => s.id === 'general')?.content, 'We sell to banks.');
  } finally {
    __setKnowledgeGitForTests(null);
  }
});

test('git wins when a LATER commit holds other content', async () => {
  __setKnowledgeGitForTests(true);
  try {
    __resetStore();
    const wf = createWorkflow(ADMIN, { title: 'Onboarding', domain: 'sales' });
    publishWorkflow(wf.id, ADMIN);
    await awaitKnowledgeCommits();
    const rec = getWorkflow(wf.id, ADMIN);
    // Another writer commits a newer version of the same workflow (a pushed edit, another replica).
    const later = { ...rec, md: rec.md.replace('Onboarding', 'Onboarding v2'), title: 'Onboarding v2' };
    await commitKnowledge('sales', { id: 'other@example.com' }, { action: 'edit workflow' }, {
      reposDir: config.reposDir, mirror: false, captured: { workflows: [later], manual: null }, timestamp: Math.floor(Date.now() / 1000) + 60,
    });
    await reconcileKnowledgeFromGit(['sales']);
    assert.equal(getWorkflow(wf.id, ADMIN).title, 'Onboarding v2', 'git wins over the older store copy');

  } finally {
    __setKnowledgeGitForTests(null);
  }
});

test('a store copy NEWER than the head commit (a lost commit) is re-committed, never overwritten', async () => {
  __setKnowledgeGitForTests(true);
  try {
    __resetStore();
    const wf = createWorkflow(ADMIN, { title: 'Invoicing', domain: 'sales' });
    publishWorkflow(wf.id, ADMIN);
    await awaitKnowledgeCommits();
    await new Promise((r) => setTimeout(r, 20));
    __setKnowledgeGitForTests(false); // this edit's commit is "lost"
    const cur = getWorkflow(wf.id, ADMIN);
    updateWorkflow(wf.id, ADMIN, { md: cur.md.replace('Invoicing', 'Invoicing v2') });
    __setKnowledgeGitForTests(true);
    await reconcileKnowledgeFromGit(['sales']);
    await awaitKnowledgeCommits();
    assert.equal(getWorkflow(wf.id, ADMIN).title, 'Invoicing v2', 'the newer edit is kept');
    const head = await readKnowledgeFromGit('sales', { reposDir: config.reposDir });
    assert.equal(head!.workflows.find((w) => w.id === wf.id)!.title, 'Invoicing v2', 'and git now holds it');
  } finally {
    __setKnowledgeGitForTests(null);
  }
});

test('NEGATIVE: with git off nothing is committed and reconcile reports nothing, never pretends', async () => {
  __setKnowledgeGitForTests(false);
  try {
    assert.deepEqual(await reconcileKnowledgeFromGit(['sales']), []);
  } finally {
    __setKnowledgeGitForTests(null);
  }
});
