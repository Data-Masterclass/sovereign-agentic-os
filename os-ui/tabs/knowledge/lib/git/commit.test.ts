/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        knowledge
 * FEATURE:    WP-50 — knowledge saves commit the OKF bundle; git is read back on hydrate
 * USER STORY: As a domain member I want a published workflow and the domain's operating manual to
 *             survive a restart because they are committed to the domain repository, and I want
 *             the store to be rebuilt FROM git, so the repository is the source of truth (A21).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '@core/kernel/config';
import { log, readBlob } from '@core/infra/git-store';
import { awaitKnowledgeCommits, readKnowledgeFromGit, __setKnowledgeGitForTests } from '@tabs/knowledge/lib/git/commit';
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

test('git wins over a stale store copy on reconcile', async () => {
  __setKnowledgeGitForTests(true);
  try {
    __resetStore();
    const wf = createWorkflow(ADMIN, { title: 'Onboarding', domain: 'sales' });
    publishWorkflow(wf.id, ADMIN);
    await awaitKnowledgeCommits();
    const committedMd = getWorkflow(wf.id, ADMIN).md;
    // The store drifts WITHOUT a commit (git off for this one write), then reconciles.
    __setKnowledgeGitForTests(false);
    updateWorkflow(wf.id, ADMIN, { md: committedMd.replace('Onboarding', 'Drifted') } as never);
    __setKnowledgeGitForTests(true);
    // Make the drift look older than the commit, as a lost write would.
    (getWorkflow(wf.id, ADMIN) as { updatedAt: string }).updatedAt = '2000-01-01T00:00:00.000Z';
    await reconcileKnowledgeFromGit(['sales']);
    assert.equal(getWorkflow(wf.id, ADMIN).md, committedMd);
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
