/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        knowledge
 * FEATURE:    WP-50 — a domain's knowledge is an OKF v0.3 bundle at `knowledge/` in its repository
 * USER STORY: As an engineer who clones my domain's repository I want its shared workflows, their
 *             tacit notes, their hard rules as OPA data and the domain's operating manual as an
 *             Open Knowledge Format bundle any OKF consumer can read, with the OS facts only in
 *             OKF's extension key (design 11 A19–A21, A24, A29).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import yaml from 'js-yaml';
import { KNOWLEDGE_PREFIX, canonicalMd, generateKnowledgeFiles, readKnowledgeBundle, splitFrontmatter } from '@tabs/knowledge/lib/git/bundle';
import { compileGuardrails } from '@tabs/knowledge/lib/guardrails';
import { parseWorkflow } from '@tabs/knowledge/lib/schema';
import { manual, workflowRecord, WF_MD } from '@tabs/knowledge/lib/git/fixtures';

const files = () => generateKnowledgeFiles('sales', { workflows: [workflowRecord()], manual: manual() });

test('the bundle has an OKF root index, the workflow, its tacit notes, its guardrails and the manual', () => {
  const f = files();
  assert.deepEqual([...f.keys()].sort(), [
    'knowledge/README.md',
    'knowledge/index.md',
    'knowledge/manual/domain.md',
    'knowledge/workflows/bank-submission/guardrails.json',
    'knowledge/workflows/bank-submission/tacit.md',
    'knowledge/workflows/bank-submission/workflow.md',
  ]);
  for (const p of f.keys()) assert.ok(p.startsWith(KNOWLEDGE_PREFIX));
  const root = splitFrontmatter(f.get('knowledge/index.md')!);
  assert.equal((root.front as Record<string, unknown>).okf_version, '0.3');
  assert.match(f.get('knowledge/index.md')!, /okf_version: "0\.3"/);
  assert.match(root.body, /\[Bank Submission\]\(workflows\/bank-submission\/workflow\.md\)/);
});

test('workflow.md is an OKF concept: type, title, OKF status; OS facts only in x-sovereign-os-meta', () => {
  const { front, body } = splitFrontmatter(files().get('knowledge/workflows/bank-submission/workflow.md')!);
  const fm = front as Record<string, any>;
  assert.equal(fm.type, 'Workflow');
  assert.equal(fm.title, 'Bank Submission');
  assert.equal(fm.status, 'stable'); // the OS's `live` is OKF's `stable`
  assert.deepEqual(fm['x-sovereign-os-meta'], { id: 'wf_bank', domain: 'sales', owner: 'alex@example.com', scope: 'Shared', status: 'live', version: '3', folder: '/' });
  for (const k of ['id', 'domain', 'visibility', 'version']) assert.ok(!(k in fm), `${k} is OS metadata, not a top-level OKF key`);
  assert.equal(fm.rules.length, 2); // the workflow's own content stays
  assert.equal(body, splitFrontmatter(WF_MD).body); // the body is untouched
});

test('guardrails.json is the OPA data document of the HARD rules, exactly what the compiler produces', () => {
  const g = JSON.parse(files().get('knowledge/workflows/bank-submission/guardrails.json')!);
  assert.deepEqual(g, compileGuardrails(parseWorkflow(WF_MD)).data);
  assert.deepEqual(g.guardrails.map((x: { id: string }) => x.id).sort(), ['sr1', 'wr2']);
});

test('read-back: the bundle parses back to the store records (md in the store’s canonical form)', () => {
  const back = readKnowledgeBundle(files());
  assert.equal(back.workflows.length, 1);
  const w = back.workflows[0];
  assert.equal(w.id, 'wf_bank');
  assert.equal(w.md, canonicalMd(WF_MD));
  // A store-written md is already canonical, so it round-trips byte for byte.
  assert.equal(readKnowledgeBundle(generateKnowledgeFiles('sales', { workflows: [workflowRecord({ md: canonicalMd(WF_MD) })], manual: null })).workflows[0].md, canonicalMd(WF_MD));
  assert.equal(w.tacit, workflowRecord().tacit);
  assert.equal(w.owner, 'alex@example.com');
  assert.equal(w.visibility, 'Shared');
  assert.equal(w.status, 'live');
  assert.deepEqual(back.manual?.sections, manual().sections);
});

test('ACCESS BOUNDARY: a Personal draft, an archived workflow and another domain are never in the domain bundle', () => {
  const f = generateKnowledgeFiles('sales', {
    workflows: [
      workflowRecord({ id: 'p1', visibility: 'Personal', title: 'Private', md: WF_MD.replace('wf_bank', 'p1').replace('Shared', 'Personal') }),
      workflowRecord({ id: 'a1', archived: true, title: 'Old' }),
      workflowRecord({ id: 'f1', domain: 'finance', title: 'Fin' }),
    ],
    manual: null,
  });
  assert.ok(![...f.keys()].some((p) => p.includes('/workflows/')), [...f.keys()].join(','));
  assert.ok(![...f.values()].some((v) => v.includes('Private')));
});

test('two workflows with the same title get distinct, stable folders', () => {
  const f = generateKnowledgeFiles('sales', {
    workflows: [workflowRecord(), workflowRecord({ id: 'wf_zz9', md: WF_MD.replace('wf_bank', 'wf_zz9') })],
    manual: null,
  });
  const dirs = [...f.keys()].filter((p) => p.endsWith('/workflow.md')).sort();
  assert.deepEqual(dirs, ['knowledge/workflows/bank-submission-wf-zz9/workflow.md', 'knowledge/workflows/bank-submission/workflow.md']);
});

test('timestamps and numbers are written as quoted strings (YAML core schema, OKF W117)', () => {
  const text = files().get('knowledge/workflows/bank-submission/workflow.md')!;
  const fm = yaml.load(splitFrontmatter(text).raw, { schema: yaml.CORE_SCHEMA }) as Record<string, any>;
  assert.equal(typeof fm['x-sovereign-os-meta'].version, 'string');
});

test('an empty domain writes no bundle at all', () => {
  assert.equal(generateKnowledgeFiles('sales', { workflows: [], manual: null }).size, 0);
});
