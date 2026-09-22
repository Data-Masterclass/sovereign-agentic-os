/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Offline-stub fetch BEFORE importing the store (mirrors the other knowledge tests).
globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;

import {
  __resetStore,
  createWorkflow,
  updateWorkflow,
  updateTacit,
  getWorkflow,
  listWorkflows,
  listWorkflowVersions,
  type Principal,
} from './store.ts';
import { exportWorkflowBundle } from './okf-export.ts';
import { importBundle } from './okf-import.ts';
import { zipBundle } from './okf-zip.ts';
import { importOkfZip } from './okf-import.ts';
import { serializeWorkflow } from './schema.ts';
import type { OkfBundle } from './okf-model.ts';

const amir: Principal = { id: 'amir', domains: ['sales'], role: 'creator' };
const other: Principal = { id: 'bea', domains: ['sales'], role: 'creator' };

const here = dirname(fileURLToPath(import.meta.url));

/** Author a fully-featured Personal workflow and return its id. */
function seedWorkflow(user: Principal): string {
  const rec = createWorkflow(user, { title: 'Bank Submission', domain: 'sales' });
  const view = getWorkflow(rec.id, user);
  const md = serializeWorkflow({
    ...view.workflow,
    rules: [
      { id: 'r1', text: 'Quality over speed', hard: false, scope: 'workflow' },
    ],
    actors: [
      { name: 'Loan Officer', category: 'Human', description: 'Prepares the package.' },
    ],
    steps: [
      {
        id: 'prep', title: 'Prepare Documents', actor: 'Human', actor_name: 'Loan Officer',
        inputs: ['Customer application form'], outputs: ['Document package'], links: [],
        rules: [{ id: 'sr1', text: 'All fields required', hard: true }],
        tacit: 'Check section 4 — the date field is frequently missed.',
      },
      {
        id: 'submit', title: 'Submit to Bank', actor: 'Software', actor_name: 'Salesforce API',
        inputs: ['Document package'], outputs: [], links: [], rules: [], tacit: '',
      },
    ],
  });
  updateWorkflow(rec.id, user, { md });
  updateTacit(rec.id, user, '## Weekend rule\nHigh-value packages route to finance even on weekends.');
  return rec.id;
}

test('round-trip: export a workflow → re-import → lossless (steps/actors/rules/tacit + tier)', () => {
  __resetStore();
  const id = seedWorkflow(amir);
  const view = getWorkflow(id, amir);

  const bundle = exportWorkflowBundle(view);
  // The bundle validates + has a spec-correct root index + the concept.
  assert.ok(bundle.files.find((f) => f.path === 'index.md'));
  assert.ok(bundle.files.find((f) => f.path.startsWith('workflows/') && f.path.endsWith('.md') && f.path !== 'workflows/index.md'));

  // Re-import into a DIFFERENT owner (foreign consumer) → new artifact at Personal.
  const result = importBundle(bundle, other, { domain: 'sales' });
  assert.equal(result.ok, true);
  const wf = result.imported.find((c) => c.kind === 'workflow');
  assert.ok(wf, 'the workflow concept imported');
  assert.equal(wf!.outcome, 'created');

  const imported = getWorkflow(wf!.id, other);
  assert.equal(imported.visibility, 'Personal'); // governed: lands at Personal
  assert.equal(imported.owner, 'bea'); // importer as owner
  // Structure survived losslessly.
  assert.equal(imported.workflow.steps.length, 2);
  assert.equal(imported.workflow.steps[0].tacit, 'Check section 4 — the date field is frequently missed.');
  assert.equal(imported.workflow.steps[0].rules[0].text, 'All fields required');
  assert.ok(imported.workflow.actors.find((a) => a.name === 'Loan Officer' && a.description === 'Prepares the package.'));
  assert.match(imported.tacit, /Weekend rule/);
});

test('idempotency: re-import by resource URI → a NEW VERSION of the SAME artifact, not a duplicate', () => {
  __resetStore();
  const id = seedWorkflow(amir);
  const before = listWorkflows(amir).mine.length;

  // Owner re-imports their OWN exported bundle → the resource id matches → version.
  const bundle = exportWorkflowBundle(getWorkflow(id, amir));
  const r1 = importBundle(bundle, amir, { domain: 'sales' });
  assert.equal(r1.imported[0].outcome, 'versioned');
  assert.equal(r1.imported[0].id, id, 'matched the existing artifact by resource URI');
  assert.equal(listWorkflows(amir).mine.length, before, 'no duplicate created');
  // A new version was recorded.
  assert.ok(listWorkflowVersions(id, amir).length >= 1);

  // A DIFFERENT owner importing the same bundle gets a NEW artifact (can't version another's).
  const r2 = importBundle(bundle, other, { domain: 'sales' });
  assert.equal(r2.imported[0].outcome, 'created');
  assert.notEqual(r2.imported[0].id, id);
});

test("import a REAL Google OKF sample bundle → Personal-tier governed concepts; unknown types accepted", () => {
  __resetStore();
  const files: OkfBundle['files'] = [
    'index.md',
    'metrics/index.md',
    'metrics/revenue.md',
    'policies/index.md',
    'policies/revenue-recognition.md',
  ].map((rel) => ({
    path: rel,
    content: readFileSync(join(here, '__fixtures__/okf-sample-acme', rel), 'utf8'),
  }));

  const result = importOkfZip(zipBundle({ files }), amir, { domain: 'sales' });
  assert.equal(result.ok, true, 'the Google sample is conformant and imports');
  // Two concept docs (Metric + Policy — both OUTSIDE our vocabulary) imported as general.
  assert.equal(result.imported.length, 2);
  for (const c of result.imported) {
    assert.equal(c.kind, 'general', 'unknown types map to the general kind');
    assert.ok(['Metric', 'Policy'].includes(c.type), 'original type kept + shown honestly');
    assert.equal(c.outcome, 'created');
  }
  // The reserved index.md files were NOT imported as concepts.
  assert.ok(!result.imported.some((c) => c.path.endsWith('index.md')));
});

test('import: an unparseable-frontmatter bundle is REJECTED; an unknown-fields bundle is ACCEPTED', () => {
  __resetStore();
  const bad = zipBundle({ files: [{ path: 'a.md', content: '---\n: : broken :\n---\n' }] });
  const rej = importOkfZip(bad, amir, { domain: 'sales' });
  assert.equal(rej.ok, false);
  assert.ok(rej.rejected && /YAML/.test(rej.rejected));

  const good = zipBundle({ files: [{ path: 'a.md', content: '---\ntype: Gizmo\nunknown_field: 7\n---\n\nHi.\n' }] });
  const acc = importOkfZip(good, amir, { domain: 'sales' });
  assert.equal(acc.ok, true, 'unknown type + unknown field accepted (spec rule)');
  assert.equal(acc.imported.length, 1);
  // The unknown type is shown honestly in the imported doc.
  const doc = getWorkflowById(acc.imported[0].id);
  assert.ok(doc && /original type: `Gizmo`/.test(doc.md), 'unknown type preserved + surfaced');
});

test('link navigation: get_knowledge resolves knowledge→knowledge links to {id,title}; unresolvable flagged', () => {
  __resetStore();
  // A "term" workflow the process will link to.
  const term = createWorkflow(amir, { title: 'Net Amount', domain: 'sales' });
  // The main process links to the term via our resource URI + to a missing id.
  const main = createWorkflow(amir, { title: 'Revenue Process', domain: 'sales' });
  const view = getWorkflow(main.id, amir);
  // Splice a prose body in after the frontmatter (the same path author_knowledge uses).
  const prose = `Revenue uses [Net Amount](sovereign-os://knowledge/${term.id}) and [Gone](sovereign-os://knowledge/wf_missing).`;
  const md = serializeWorkflow(view.workflow).replace(/^(---\n[\s\S]*?\n---\n\n)/, `$1${prose}\n\n`);
  updateWorkflow(main.id, amir, { md });

  const walked = getWorkflow(main.id, amir);
  assert.equal(walked.knowledgeLinks.links.length, 1);
  assert.equal(walked.knowledgeLinks.links[0].id, term.id);
  assert.equal(walked.knowledgeLinks.links[0].title, 'Net Amount');
  // The unresolvable link is preserved + flagged, never dropped.
  assert.ok(walked.knowledgeLinks.unresolved.some((u) => u.href.includes('wf_missing')));
});

// Helper: read the imported personal-knowledge doc's markdown to assert type-preservation.
import { getPersonalKnowledge } from './personal-store.ts';
function getWorkflowById(id: string): { md: string } | null {
  try {
    return { md: getPersonalKnowledge(id, amir).md };
  } catch {
    return null;
  }
}
