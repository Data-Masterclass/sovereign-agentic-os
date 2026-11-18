/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseOkfDoc,
  serializeOkfDoc,
  OkfParseError,
  internalKindForType,
  idFromResource,
  workflowToOkfDoc,
  okfDocToWorkflow,
  resolveKnowledgeLinks,
  renderIndexMd,
  RESOURCE_PREFIX,
} from '@tabs/knowledge/lib/okf-model';
import { MAX_ACTOR_PROMPT_BYTES, type Workflow } from '@tabs/knowledge/lib/schema';

// A workflow with steps + actors + rules + per-step tacit — the round-trip target.
const wf: Workflow = {
  id: 'wf_x',
  title: 'Bank Submission',
  domain: 'sales',
  visibility: 'Personal',
  status: 'draft',
  version: '2',
  rules: [
    { id: 'r1', text: 'Quality over speed', hard: false, scope: 'workflow' },
    { id: 'sr1', text: 'All fields required', hard: true, scope: 'step', step_id: 'prep' },
  ],
  actors: [
    { name: 'Loan Officer', category: 'Human', description: 'Prepares the package.' },
    { name: 'Salesforce API', category: 'Software' },
  ],
  steps: [
    {
      id: 'prep',
      title: 'Prepare Documents',
      actor: 'Human',
      actor_name: 'Loan Officer',
      inputs: ['Customer application form'],
      outputs: ['Document package'],
      links: [],
      rules: [{ id: 'sr1', text: 'All fields required', hard: true }],
      tacit: 'Check section 4 — the date field is frequently missed.',
    },
    {
      id: 'submit',
      title: 'Submit to Bank',
      actor: 'Software',
      actor_name: 'Salesforce API',
      inputs: ['Document package'],
      outputs: [],
      links: [],
      rules: [],
      tacit: '',
    },
  ],
  body: 'A short prose intro.',
};

test('parseOkfDoc: type is the only required field; unknown keys preserved verbatim', () => {
  const md = `---\ntype: Widget\ntitle: A thing\nfoo_bar: 42\nnested: { a: 1 }\n---\n\nBody.\n`;
  const doc = parseOkfDoc(md);
  assert.equal(doc.type, 'Widget');
  assert.equal(doc.title, 'A thing');
  assert.deepEqual(doc.extra, { foo_bar: 42, nested: { a: 1 } });
  assert.match(doc.body, /Body\./);
});

test('parseOkfDoc: rejects unparseable frontmatter and missing/empty type', () => {
  assert.throws(() => parseOkfDoc('no frontmatter here'), OkfParseError);
  assert.throws(() => parseOkfDoc('---\n: : bad yaml :\n---\n'), OkfParseError);
  assert.throws(() => parseOkfDoc('---\ntitle: no type\n---\n'), OkfParseError);
  assert.throws(() => parseOkfDoc('---\ntype: "   "\n---\n'), OkfParseError);
});

test('parseOkfDoc: bare `verified` map is normalised to a single-element list (graceful degradation)', () => {
  const md = `---\ntype: Metric\nverified: { by: human:jsmith, at: 2026-01-01T00:00:00Z }\n---\n`;
  const doc = parseOkfDoc(md);
  assert.ok(Array.isArray(doc.verified));
  assert.equal(doc.verified!.length, 1);
  assert.equal(doc.verified![0].by, 'human:jsmith');
});

test('serializeOkfDoc → parseOkfDoc round-trips known + foreign fields', () => {
  const doc = parseOkfDoc(`---\ntype: term\ntitle: T\nresource: sovereign-os://knowledge/abc\ntags: [a, b]\nweird: keep-me\n---\n\nHi.\n`);
  const back = parseOkfDoc(serializeOkfDoc(doc));
  assert.equal(back.type, 'term');
  assert.equal(back.resource, 'sovereign-os://knowledge/abc');
  assert.deepEqual(back.tags, ['a', 'b']);
  assert.deepEqual(back.extra, { weird: 'keep-me' });
});

test('internalKindForType: only `workflow` maps to workflow; everything else → general', () => {
  assert.equal(internalKindForType('workflow'), 'workflow');
  assert.equal(internalKindForType('WorkFlow'), 'workflow');
  assert.equal(internalKindForType('term'), 'general');
  assert.equal(internalKindForType('Attested Computation'), 'general');
});

test('idFromResource: extracts our id from the resource URI', () => {
  assert.equal(idFromResource(`${RESOURCE_PREFIX}wf_123`), 'wf_123');
  assert.equal(idFromResource('https://example.com/x'), null);
  assert.equal(idFromResource(undefined), null);
});

test('workflow → OKF doc → workflow round-trips steps/actors/rules/tacit losslessly', () => {
  const doc = workflowToOkfDoc(wf, {
    id: 'wf_x', owner: 'amir', domain: 'sales', tier: 'Personal',
    generatedAt: '2026-08-05T00:00:00Z', tacit: '## Note\nWatch weekends.',
  });
  assert.equal(doc.type, 'workflow');
  assert.equal(doc.resource, `${RESOURCE_PREFIX}wf_x`);
  assert.equal(doc.status, 'draft'); // Personal → draft
  // Readable body carries the headings.
  assert.match(doc.body, /# Steps/);
  assert.match(doc.body, /Prepare Documents/);
  assert.match(doc.body, /tacit: Check section 4/);
  assert.match(doc.body, /# Tacit knowledge/);

  const back = okfDocToWorkflow(doc, 'wf_x', 'sales');
  assert.equal(back.title, 'Bank Submission');
  assert.equal(back.version, '2');
  assert.equal(back.steps.length, 2);
  assert.equal(back.steps[0].id, 'prep');
  assert.equal(back.steps[0].tacit, 'Check section 4 — the date field is frequently missed.');
  assert.equal(back.steps[0].rules[0].text, 'All fields required');
  assert.deepEqual(back.steps[0].inputs, ['Customer application form']);
  // Workflow-level + step-scoped rules both survive via the extension block.
  assert.equal(back.rules.length, 2);
  assert.ok(back.rules.find((r) => r.scope === 'step' && r.step_id === 'prep'));
  // Actors (incl. description + the derived Software actor) survive.
  assert.ok(back.actors.find((a) => a.name === 'Loan Officer' && a.description === 'Prepares the package.'));
  assert.ok(back.actors.find((a) => a.name === 'Salesforce API' && a.category === 'Software'));
});

test('okfDocToWorkflow: a FOREIGN workflow bundle (no extension) degrades to prose body, never throws', () => {
  const doc = parseOkfDoc(`---\ntype: workflow\ntitle: Foreign SOP\n---\n\nDo step one. Then step two.\n`);
  const w = okfDocToWorkflow(doc, 'wf_new', 'ops');
  assert.equal(w.title, 'Foreign SOP');
  assert.equal(w.steps.length, 0);
  assert.match(w.body, /Do step one/);
});

test('resolveKnowledgeLinks: resolves known links, flags unresolvable, dedupes, never drops', () => {
  const md = [
    `See [Refund Rule](${RESOURCE_PREFIX}wf_rule) and [Glossary](${RESOURCE_PREFIX}wf_term).`,
    `Also [Missing](${RESOURCE_PREFIX}wf_gone) and a relative [doc](../workflows/other.md).`,
    `Dup: ${RESOURCE_PREFIX}wf_rule`,
  ].join('\n');
  const known: Record<string, string> = { wf_rule: 'Refund Rule', wf_term: 'Refund Term' };
  const { links, unresolved } = resolveKnowledgeLinks(md, (id) => known[id] ?? null);
  assert.deepEqual(links.map((l) => l.id).sort(), ['wf_rule', 'wf_term']);
  assert.equal(links.find((l) => l.id === 'wf_rule')!.title, 'Refund Rule');
  // wf_gone (unknown id) + the relative .md link are both flagged, not dropped.
  assert.ok(unresolved.some((u) => u.href.includes('wf_gone')));
  assert.ok(unresolved.some((u) => u.href.includes('other.md')));
});

test('an Agent actor prompt survives an OKF export → import round trip', () => {
  // The prompt is the head of the AGENT.md the agent system carries, so an export that
  // dropped it would hand the importer a workflow whose agents had lost their brief.
  const withAgent: Workflow = {
    ...wf,
    actors: [
      ...wf.actors,
      { id: 'actor-agent-triage-bot', name: 'Triage Bot', category: 'Agent', prompt: '# Triage Bot\n\nYou triage.' },
    ],
  };
  const doc = workflowToOkfDoc(withAgent, { id: 'wf_x', owner: 'u1', domain: 'sales', tier: 'Personal' });
  const back = okfDocToWorkflow(doc, 'wf_x', 'sales');
  const bot = back.actors.find((a) => a.name === 'Triage Bot');
  assert.ok(bot, 'the Agent actor survives');
  assert.equal(bot?.prompt, '# Triage Bot\n\nYou triage.');
  assert.equal(bot?.id, 'actor-agent-triage-bot', 'the actor id survives too');
});

test('an imported prompt is capped and CRLF-normalised like every other inlet (review R2)', () => {
  // An OKF bundle is an inlet for prompt text, and `okfDocToWorkflow` must not throw
  // (its contract is graceful degradation) — so it truncates and MARKS the truncation,
  // exactly like reading a stored workflow.md does.
  const doc = workflowToOkfDoc(wf, { id: 'wf_x', owner: 'u1', domain: 'sales', tier: 'Personal' });
  doc.sovereign_os!.workflow!.actors = [
    { id: 'a-crlf', name: 'CRLF Bot', category: 'Agent', prompt: 'one\r\ntwo' },
    { id: 'a-big', name: 'Big Bot', category: 'Agent', prompt: 'x'.repeat(MAX_ACTOR_PROMPT_BYTES + 5) },
  ];
  const back = okfDocToWorkflow(doc, 'wf_x', 'sales');
  const crlf = back.actors.find((a) => a.name === 'CRLF Bot');
  assert.equal(crlf?.prompt, 'one\ntwo');
  const big = back.actors.find((a) => a.name === 'Big Bot');
  assert.equal(big?.prompt?.length, MAX_ACTOR_PROMPT_BYTES);
  assert.equal(big?.promptTruncatedFrom, MAX_ACTOR_PROMPT_BYTES + 5);
});

test('renderIndexMd: subdirectories + concepts render in spec form', () => {
  const md = renderIndexMd([
    { path: 'metrics/index.md', title: 'Metrics', description: 'The numbers.', isDir: true },
    { path: 'revenue.md', title: 'Revenue', description: 'FY revenue.' },
  ]);
  assert.match(md, /# Subdirectories/);
  assert.match(md, /\* \[Metrics\]\(metrics\/index\.md\) - The numbers\./);
  assert.match(md, /\* \[Revenue\]\(revenue\.md\) - FY revenue\./);
});
