/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWorkflow,
  serializeWorkflow,
  KnowledgeError,
  emptyDomainKnowledge,
  DOMAIN_SECTION_IDS,
  MAX_ACTOR_PROMPT_BYTES,
  readActorPrompt,
} from '@tabs/knowledge/lib/schema';

const VALID_WORKFLOW = `---
id: bank-submission
title: Bank Submission
domain: sales
visibility: Personal
status: draft
version: "1"
rules:
  - id: r1
    text: Quality over customer convenience
    hard: false
    scope: workflow
  - id: r2
    text: Error rate must be below 0.1%
    hard: true
    scope: step
    step_id: verify
---

\`\`\`step
id: prepare-documents
title: Prepare Documents
actor: Human
actor_name: Loan Officer
inputs:
  - Customer application form
outputs:
  - Document package
links:
  - type: data
    ref: sales.gold.customer_applications
    label: Customer Applications
rules:
  - id: sr1
    text: All required fields must be completed
    hard: false
\`\`\`

> tacit: Loan officers often miss the income verification date in section 4.

\`\`\`step
id: submit-to-bank
title: Submit to Bank Portal
actor: Software
actor_name: BankPortal
links:
  - type: app
    ref: app://bank-portal
    label: Bank Portal
rules:
  - id: sr2
    text: Error rate must be below 0.1%
    hard: true
\`\`\`

\`\`\`step
id: verify
title: Verify Submission
actor: Agent
actor_name: Verification Agent
outputs:
  - Submission receipt
links:
  - type: agent
    ref: sys_verify_agent
    label: Verification Agent
\`\`\`
`;

test('parses a valid workflow.md', () => {
  const w = parseWorkflow(VALID_WORKFLOW);
  assert.equal(w.id, 'bank-submission');
  assert.equal(w.title, 'Bank Submission');
  assert.equal(w.domain, 'sales');
  assert.equal(w.visibility, 'Personal');
  assert.equal(w.status, 'draft');
  assert.equal(w.version, '1');
});

test('parses workflow-level rules', () => {
  const w = parseWorkflow(VALID_WORKFLOW);
  assert.equal(w.rules.length, 2);
  assert.equal(w.rules[0].id, 'r1');
  assert.equal(w.rules[0].hard, false);
  assert.equal(w.rules[0].scope, 'workflow');
  assert.equal(w.rules[1].hard, true);
  assert.equal(w.rules[1].scope, 'step');
  assert.equal(w.rules[1].step_id, 'verify');
});

test('parses three step blocks', () => {
  const w = parseWorkflow(VALID_WORKFLOW);
  assert.equal(w.steps.length, 3);
});

test('parses step metadata — actor, I/O, links, step-level rules', () => {
  const w = parseWorkflow(VALID_WORKFLOW);
  const s0 = w.steps[0];
  assert.equal(s0.id, 'prepare-documents');
  assert.equal(s0.actor, 'Human');
  assert.equal(s0.actor_name, 'Loan Officer');
  assert.deepEqual(s0.inputs, ['Customer application form']);
  assert.deepEqual(s0.outputs, ['Document package']);
  assert.equal(s0.links.length, 1);
  assert.equal(s0.links[0].type, 'data');
  assert.equal(s0.links[0].ref, 'sales.gold.customer_applications');
  assert.equal(s0.links[0].label, 'Customer Applications');
  assert.equal(s0.rules.length, 1);
  assert.equal(s0.rules[0].hard, false);
});

test('parses inline tacit note after first step', () => {
  const w = parseWorkflow(VALID_WORKFLOW);
  assert.ok(w.steps[0].tacit.includes('section 4'), `expected tacit note; got: ${w.steps[0].tacit}`);
});

test('step with no tacit note has empty tacit string', () => {
  const w = parseWorkflow(VALID_WORKFLOW);
  assert.equal(w.steps[2].tacit, '');
});

test('Software and Agent actors parse correctly', () => {
  const w = parseWorkflow(VALID_WORKFLOW);
  assert.equal(w.steps[1].actor, 'Software');
  assert.equal(w.steps[2].actor, 'Agent');
});

test('round-trip: serialize → parse returns equivalent data', () => {
  const w = parseWorkflow(VALID_WORKFLOW);
  const serialized = serializeWorkflow(w);
  const again = parseWorkflow(serialized);
  assert.equal(again.id, w.id);
  assert.equal(again.title, w.title);
  assert.equal(again.steps.length, w.steps.length);
  assert.equal(again.steps[0].actor, 'Human');
  assert.equal(again.steps[1].actor, 'Software');
  assert.equal(again.steps[2].actor, 'Agent');
  assert.equal(again.rules.length, w.rules.length);
});

test('round-trip preserves tacit notes', () => {
  const w = parseWorkflow(VALID_WORKFLOW);
  const again = parseWorkflow(serializeWorkflow(w));
  assert.ok(again.steps[0].tacit.includes('section 4'));
});

// A multi-line note is where the parser and the serializer used to disagree: the
// serializer writes `> tacit: ` on EVERY line, the parser stripped only `> `, so each
// round trip grew literal `tacit: ` prefixes — and a line starting `---` or a fence
// truncated the note outright. Three lines, one of each shape.
const MULTILINE_TACIT = [
  'Check section 4 — the date field is frequently missed.',
  '--- escalate to the desk head ---',
  '```',
].join('\n');

test('tacit: a three-line note with a --- line and a fence line round-trips unchanged', () => {
  const w = parseWorkflow(VALID_WORKFLOW);
  w.steps[0].tacit = MULTILINE_TACIT;
  const once = parseWorkflow(serializeWorkflow(w));
  assert.equal(once.steps[0].tacit, MULTILINE_TACIT);
  const twice = parseWorkflow(serializeWorkflow(once));
  assert.equal(twice.steps[0].tacit, MULTILINE_TACIT, 'a second round trip must not add `tacit: ` prefixes');
  assert.equal(twice.steps[1].tacit, '', 'the note must not leak into the next step');
  assert.equal(twice.steps.length, w.steps.length, 'a fence inside the note must not split the document');
});

test('tacit: a hand-written lazy continuation line (no > prefix) is kept, not dropped', () => {
  // Markdown's own blockquote lazy continuation: a human editing workflow.md by hand writes the
  // second line without the `>`. The old regex captured it; the line scanner must too, or the
  // next commit through the UI would delete someone's sentence.
  const md = VALID_WORKFLOW.replace(
    '> tacit: Loan officers often miss the income verification date in section 4.',
    '> tacit: Loan officers often miss the income verification date in section 4.\nAsk the desk head when it is blank.',
  );
  const w = parseWorkflow(md);
  assert.equal(
    w.steps[0].tacit,
    'Loan officers often miss the income verification date in section 4.\nAsk the desk head when it is blank.',
  );
  // …and once committed it round-trips as a proper `> tacit:` blockquote.
  const again = parseWorkflow(serializeWorkflow(w));
  assert.equal(again.steps[0].tacit, w.steps[0].tacit);
});

test('tacit: a blank line, a fence or a --- ends the note (prose after it is not swallowed)', () => {
  const md = VALID_WORKFLOW.replace(
    '> tacit: Loan officers often miss the income verification date in section 4.',
    '> tacit: Note one.\n\nThis paragraph belongs to the document, not to the note.',
  );
  const w = parseWorkflow(md);
  assert.equal(w.steps[0].tacit, 'Note one.');
});

test('throws KnowledgeError when frontmatter is missing', () => {
  assert.throws(() => parseWorkflow('# No frontmatter'), KnowledgeError);
});

test('throws KnowledgeError on invalid visibility', () => {
  const bad = VALID_WORKFLOW.replace('visibility: Personal', 'visibility: Secret');
  assert.throws(() => parseWorkflow(bad), KnowledgeError);
});

test('throws KnowledgeError on invalid status', () => {
  const bad = VALID_WORKFLOW.replace('status: draft', 'status: pending');
  assert.throws(() => parseWorkflow(bad), KnowledgeError);
});

// ------------------------------------------------------------ actors ---------

const WORKFLOW_WITH_ACTORS = `---
id: onboarding
title: Partner Onboarding
domain: sales
visibility: Personal
status: draft
version: "1"
actors:
  - name: Loan Officer
    category: Human
    description: Approves deals over EUR 50k.
  - name: Salesforce API
    category: Software
    description: Nightly REST ingestion of leads.
  - name: Campaign Optimizer
    category: Agent
    description: The OS agent system that tunes spend.
  - name: Acme Buyer
    category: Customer
    description: The external customer placing the order.
  - name: Fulfilment Partner
    category: Partner
    description: External 3PL that ships the goods.
---

\`\`\`step
id: intake
title: Intake request
actor: Customer
actor_name: Acme Buyer
\`\`\`

\`\`\`step
id: sync
title: Sync to CRM
actor: Software
actor_name: Salesforce API
\`\`\`

\`\`\`step
id: ship
title: Hand to fulfilment
actor: Partner
actor_name: Fulfilment Partner
\`\`\`
`;

test('parses the five actor categories on steps', () => {
  const w = parseWorkflow(WORKFLOW_WITH_ACTORS);
  assert.equal(w.steps[0].actor, 'Customer');
  assert.equal(w.steps[1].actor, 'Software');
  assert.equal(w.steps[2].actor, 'Partner');
});

test('parses the actors registry with descriptions incl external', () => {
  const w = parseWorkflow(WORKFLOW_WITH_ACTORS);
  assert.equal(w.actors.length, 5);
  const officer = w.actors.find((a) => a.name === 'Loan Officer');
  assert.equal(officer?.category, 'Human');
  assert.equal(officer?.description, 'Approves deals over EUR 50k.');
  const buyer = w.actors.find((a) => a.name === 'Acme Buyer');
  assert.equal(buyer?.category, 'Customer');
  const partner = w.actors.find((a) => a.name === 'Fulfilment Partner');
  assert.equal(partner?.category, 'Partner');
  assert.ok(partner?.description?.includes('3PL'));
});

test('round-trip: serialize → parse preserves the actors registry (incl external + descriptions)', () => {
  const w = parseWorkflow(WORKFLOW_WITH_ACTORS);
  const again = parseWorkflow(serializeWorkflow(w));
  assert.equal(again.actors.length, 5);
  for (const a of w.actors) {
    const match = again.actors.find((x) => x.category === a.category && x.name === a.name);
    assert.ok(match, `actor ${a.category}:${a.name} lost on round-trip`);
    assert.equal(match?.description, a.description);
  }
  assert.equal(again.steps[0].actor, 'Customer');
  assert.equal(again.steps[2].actor, 'Partner');
});

test('back-compat: an old workflow.md with NO actors section derives a registry from steps', () => {
  // VALID_WORKFLOW predates the actors section — parsing must not crash and the
  // registry is derived from the steps' distinct (category, name) pairs.
  const w = parseWorkflow(VALID_WORKFLOW);
  assert.equal(w.actors.length, 3);
  assert.deepEqual(
    w.actors.map((a) => `${a.category}:${a.name}`).sort(),
    ['Agent:Verification Agent', 'Human:Loan Officer', 'Software:BankPortal'].sort(),
  );
  // Derived actors carry no description (none was declared).
  assert.ok(w.actors.every((a) => a.description === undefined));
});

// ------------------------------------------------- an Agent actor's long prompt ---
// The prompt is the head of the AGENT.md the agent system carries, so losing a line of
// it loses the author's work. `js-yaml` writes it as a `|-` block scalar; the round trip
// has to be a FIXED POINT, or every save would rewrite the file.
const AGENT_PROMPT = [
  '# Triage Bot',
  '',
  'You are the triage desk.',
  '--- escalate to the desk head ---',
  '```',
  'json',
  '```',
  '',
  'Always answer in English.',
].join('\n');

test('an Agent actor prompt round-trips unchanged, and twice is a fixed point', () => {
  const w = parseWorkflow(VALID_WORKFLOW);
  w.actors = [{ id: 'actor-agent-triage-bot', name: 'Triage Bot', category: 'Agent', prompt: AGENT_PROMPT }];
  const md = serializeWorkflow(w);
  const once = parseWorkflow(md);
  assert.equal(once.actors.length, 1);
  assert.equal(once.actors[0].prompt, AGENT_PROMPT);
  const twice = parseWorkflow(serializeWorkflow(once));
  assert.equal(twice.actors[0].prompt, AGENT_PROMPT, 'a second round trip must not alter the prompt');
  assert.equal(serializeWorkflow(twice), serializeWorkflow(once), 'serialize must be a fixed point');
});

test('an actor with no prompt writes no prompt key', () => {
  const w = parseWorkflow(VALID_WORKFLOW);
  const md = serializeWorkflow(w);
  assert.ok(!/prompt:/.test(md), 'a workflow whose actors have no prompt must not grow the key');
  assert.ok(parseWorkflow(md).actors.every((a) => a.prompt === undefined));
});

test('a WRITE refuses an over-cap prompt, with a typed error rather than an unbounded brief', () => {
  const w = parseWorkflow(VALID_WORKFLOW);
  const tooBig = 'x'.repeat(MAX_ACTOR_PROMPT_BYTES + 1);
  w.actors = [{ id: 'actor-agent-bot', name: 'Bot', category: 'Agent', prompt: tooBig }];
  // The serializer refuses it where the user can still see (and shorten) their draft.
  assert.throws(() => serializeWorkflow(w), (e: unknown) => {
    assert.ok(e instanceof KnowledgeError);
    assert.match((e as Error).message, /prompt is \d+ bytes.*64 KiB/);
    return true;
  });
});

test('an over-cap prompt in a STORED file truncates with a warning — the workflow still opens', () => {
  // A throw on the read path would make the workflow unopenable, which is worse than a
  // bounded prompt the author is told about. The WRITE paths still refuse (above).
  const tooBig = 'x'.repeat(MAX_ACTOR_PROMPT_BYTES + 10);
  const md = `---\nid: x\ntitle: X\ndomain: d\nvisibility: Personal\nstatus: draft\nversion: "1"\nactors:\n  - {id: a1, name: Bot, category: Agent, prompt: "${tooBig}"}\n---\n`;
  const w = parseWorkflow(md);
  assert.equal(w.actors[0].prompt?.length, MAX_ACTOR_PROMPT_BYTES);
  assert.equal(w.actors[0].promptTruncatedFrom, MAX_ACTOR_PROMPT_BYTES + 10);
  // The truncated prompt is within the cap, so saving it back does not throw.
  assert.doesNotThrow(() => serializeWorkflow(w));
  // …and the marker is editor-only state: it never reaches the file.
  assert.ok(!serializeWorkflow(w).includes('promptTruncatedFrom'));
});

test('readActorPrompt cuts on a character boundary, never mid-codepoint', () => {
  const emoji = '😀'; // 4 bytes
  const raw = 'a'.repeat(MAX_ACTOR_PROMPT_BYTES - 2) + emoji + emoji;
  const out = readActorPrompt(raw);
  assert.ok(new TextEncoder().encode(out.prompt).length <= MAX_ACTOR_PROMPT_BYTES);
  assert.ok(!out.prompt.includes('�'), 'no replacement character from a split codepoint');
  assert.equal(out.truncatedFrom, new TextEncoder().encode(raw).length);
});

test('a prompt within the cap reports no truncation', () => {
  assert.deepEqual(readActorPrompt('  fine\r\n '), { prompt: 'fine' });
});

test('a CRLF prompt is normalised, so js-yaml keeps writing a readable block scalar', () => {
  const md = [
    '---', 'id: x', 'title: X', 'domain: d', 'visibility: Personal', 'status: draft', 'version: "1"',
    'actors:', '  - id: a1', '    name: Bot', '    category: Agent', '    prompt: "one\\r\\ntwo\\rthree"',
    '---', '',
  ].join('\n');
  const w = parseWorkflow(md);
  assert.equal(w.actors[0].prompt, 'one\ntwo\nthree');
  assert.match(serializeWorkflow(w), /prompt: \|-\n/, 'a multi-line prompt stays a block scalar');
});

test('a prompt on a non-Agent actor survives — the category is the editor’s business, not the model’s', () => {
  // Switching an actor's category must never silently destroy the prompt the author wrote.
  const w = parseWorkflow(VALID_WORKFLOW);
  w.actors = [{ id: 'actor-human-officer', name: 'Loan Officer', category: 'Human', prompt: 'Keep me.' }];
  assert.equal(parseWorkflow(serializeWorkflow(w)).actors[0].prompt, 'Keep me.');
});

test('emptyDomainKnowledge returns seven sections in canonical order', () => {
  const dk = emptyDomainKnowledge('sales');
  assert.equal(dk.domain, 'sales');
  assert.equal(dk.sections.length, 7);
  assert.deepEqual(dk.sections.map((s) => s.id), [...DOMAIN_SECTION_IDS]);
  assert.ok(dk.sections.every((s) => s.content === ''), 'all sections start empty');
});
