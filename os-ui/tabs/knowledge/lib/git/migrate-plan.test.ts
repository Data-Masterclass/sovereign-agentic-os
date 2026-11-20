/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        knowledge
 * FEATURE:    WP-50 — the DRY-RUN plan that moves existing live workflow records into git
 * USER STORY: As an operator I want to see which OKF files each domain repository would gain, which
 *             records cannot move and why, and that Personal drafts stay out — before any write.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { knowledgeRecordsFromJson, planKnowledgeMigration } from '@tabs/knowledge/lib/git/migrate-plan';
import { workflowRecord } from '@tabs/knowledge/lib/git/fixtures';

test('plans shared workflows per domain; counts Personal and archived; refuses an unparsable record', () => {
  const recs = [
    workflowRecord(),
    workflowRecord({ id: 'p1', visibility: 'Personal' }),
    workflowRecord({ id: 'a1', archived: true }),
    workflowRecord({ id: 'bad', md: 'no frontmatter at all' }),
  ];
  const plan = planKnowledgeMigration(knowledgeRecordsFromJson(JSON.stringify({ hits: { hits: recs.map((r) => ({ _source: r })) } })));
  assert.equal(plan.mode, 'dry-run');
  assert.deepEqual(plan.domains.map((d) => [d.domain, d.workflows]), [['sales', ['wf_bank']]]);
  assert.ok(plan.domains[0].files.includes('knowledge/workflows/bank-submission/workflow.md'));
  assert.deepEqual(plan.refused.map((r) => r.id), ['bad']);
  assert.equal(plan.personal, 1);
  assert.equal(plan.archived, 1);
  assert.match(plan.manual, /not-exportable/);
});
