/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       agents
 * FEATURE:    Declaring an output gives the producing agent the tool to write it — there, and only there
 * USER STORY: As an author I said on the first step where the report goes. The agent that writes
 *             it must be able to save it without me finding and adding a tool, must not be able
 *             to write anywhere else, and must be told the folder instead of guessing it.
 * ARCHITECTURE:
 *   - `withOutputTools` / `outputsBrief` / `outputLanding` are pure (`output-tools.ts`); the
 *     folder rule is the run's own check (`checkGrantScope`, `build/grant-scope.ts`) and the hold
 *     rule is `build/hold.ts` — tested here through them, not re-stated.
 *   - The reported case: a narrowed agent (its own `tools:` list) never received `upload_file`
 *     when an output put it into the team pool, and the capability picker lists no tools.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSystem, serializeSystem, type System } from '@tabs/agents/lib/system-schema';
import { addOutput, removeOutput, setArtifactGrant, setFolderGrant, setFolderGrantLevel, setOutputAgent } from '@tabs/agents/lib/simple-edit';
import { compile } from '@tabs/agents/lib/langgraph-compile';
import {
  agentOutputTools, outputCaveats, outputLanding, outputsBrief, outputSection, withOutputTools, OUTPUT_TOOL,
} from '@tabs/agents/lib/output-tools';
import { checkGrantScope, grantScopeOf, type GrantResolvers } from '@tabs/agents/lib/build/grant-scope';
import { holdDecisionFor } from '@tabs/agents/lib/build/hold';

/** Two agents: `reader` narrowed to read tools, `writer` narrowed to nothing useful, `free` inherits. */
function team(): System {
  return parseSystem({
    version: '1',
    system: { name: 'Invoice desk', domain: 'finance', visibility: 'Personal' },
    entrypoint: 'reader',
    grants: { tools: ['list_files', 'get_file'], files: [{ folder: { path: '/invoices', scope: 'domain' }, capability: 'Read' }] },
    agents: [
      { id: 'reader', role: 'reads', agent_md: '', memory_md: '', tools: ['list_files', 'get_file'] },
      { id: 'writer', role: 'writes the report', agent_md: '', memory_md: '', tools: ['get_file'] },
      { id: 'free', role: 'helps', agent_md: '', memory_md: '' },
    ],
    edges: [],
  });
}

const RESOLVERS: GrantResolvers = { fileLocations: async () => [], datasetTables: async () => [] };
const toolsOf = (sys: System, id: string) => sys.agents.find((a) => a.id === id)!.tools;

for (const kind of ['files', 'knowledge', 'data'] as const) {
  test(`declaring a ${kind} output provisions ${OUTPUT_TOOL[kind]} for the producing agent and not for the others`, () => {
    let sys = addOutput(team(), { kind, name: 'Report', folder: { path: '/reports', scope: 'personal' }, agent: 'writer' });
    assert.ok(sys.grants.tools.includes(OUTPUT_TOOL[kind]), 'the team pool holds the tool (the stored definition)');
    assert.ok(!toolsOf(sys, 'writer')!.includes(OUTPUT_TOOL[kind]), 'nothing is written into the agent\'s own list');

    const run = withOutputTools(sys);
    assert.ok(toolsOf(run, 'writer')!.includes(OUTPUT_TOOL[kind]), 'the producer has it at run time');
    assert.ok(!toolsOf(run, 'reader')!.includes(OUTPUT_TOOL[kind]), 'a narrowed non-producer does not');
    assert.ok(toolsOf(run, 'free') !== undefined && !toolsOf(run, 'free')!.includes(OUTPUT_TOOL[kind]), 'an inheriting non-producer does not either');
    assert.ok(toolsOf(run, 'free')!.includes('get_file'), '…and keeps the rest of the pool');
    assert.deepEqual(agentOutputTools(sys, 'reader'), []);
    assert.ok(agentOutputTools(sys, 'writer').includes(OUTPUT_TOOL[kind]), 'the builder can say which agent saves with which tool');
    assert.doesNotThrow(() => compile(parseSystem(serializeSystem(run))), 'the run definition still compiles (narrow-only holds)');

    // No producer named ⇒ any agent may write it, narrowed ones included.
    sys = setOutputAgent(sys, 0, null);
    const open = withOutputTools(sys);
    assert.ok(toolsOf(open, 'reader')!.includes(OUTPUT_TOOL[kind]));
    assert.equal(toolsOf(open, 'free'), undefined, 'an inheriting agent is left inheriting');
  });
}

test('removing the output removes the tool again — unless a write grant the builder made still needs it', () => {
  let sys = addOutput(team(), { kind: 'files', name: 'Report', folder: { path: '/reports', scope: 'personal' }, agent: 'writer' });
  const gone = removeOutput(sys, 0);
  assert.ok(!gone.grants.tools.includes('upload_file'));
  assert.ok(!toolsOf(withOutputTools(gone), 'writer')!.includes('upload_file'));

  // The builder ALSO granted a folder Read + write by hand: that grant keeps the tool.
  sys = setFolderGrant(sys, 'files', { path: '/scratch', scope: 'personal' }, true);
  const kept = removeOutput(sys, 0);
  assert.ok(kept.grants.tools.includes('upload_file'));
});

test('granting a file or folder to READ no longer takes upload_file away from a declared output', () => {
  let sys = addOutput(team(), { kind: 'files', name: 'Report', folder: { path: '/reports', scope: 'personal' } });
  sys = setFolderGrant(sys, 'files', { path: '/more', scope: 'domain' }, false);
  sys = setArtifactGrant(sys, 'files', 'file_x', false);
  assert.ok(sys.grants.tools.includes('upload_file'));
  assert.ok(sys.grants.files.some((g) => g.id === 'file_x'), 'the single-file grant is stored');
});

test('an output whose folder was turned down to Read provisions nothing and says so', () => {
  let sys = addOutput(team(), { kind: 'files', name: 'Report', folder: { path: '/reports', scope: 'personal' }, agent: 'writer' });
  sys = setFolderGrantLevel(sys, 'files', { path: '/reports', scope: 'personal' }, 'read-only');
  assert.ok(!toolsOf(withOutputTools(sys), 'writer')!.includes('upload_file'));
  assert.equal(outputLanding(sys, sys.outputs![0]).mode, 'blocked');
  assert.equal(outputsBrief(sys), '');
});

test('the tool writes INSIDE the declared folder and is refused outside it', async () => {
  const sys = addOutput(team(), { kind: 'files', name: 'Report', folder: { path: '/reports', scope: 'personal' }, agent: 'writer' });
  const scope = grantScopeOf(withOutputTools(sys));
  assert.equal((await checkGrantScope('upload_file', { name: 'r.md', folder: '/reports' }, scope, RESOLVERS)).allow, true);
  assert.equal((await checkGrantScope('upload_file', { name: 'r.md', folder: '/reports/2026' }, scope, RESOLVERS)).allow, true);
  for (const folder of ['/elsewhere', '/', undefined, '/invoices']) {
    const v = await checkGrantScope('upload_file', { name: 'r.md', ...(folder ? { folder } : {}) }, scope, RESOLVERS);
    assert.equal(v.allow, false, `refused for ${folder ?? '(no folder)'}`);
    if (!v.allow) assert.match(v.refusal.reason, /writes files only to \/reports \(My files\)/);
  }
});

test('hold behaviour is unchanged: a My write runs directly, a Domain promotion is held, read-only holds everything', () => {
  let sys = addOutput(team(), { kind: 'files', name: 'Report', folder: { path: '/reports', scope: 'personal' } });
  assert.equal(sys.safetyPreset, 'read-bounded', 'declaring a write output lifts a read-only team, as before');
  assert.deepEqual(holdDecisionFor(sys.safetyPreset, 'upload_file'), { held: false });
  assert.deepEqual(holdDecisionFor(sys.safetyPreset, 'request_promotion'), { held: true, approverRole: 'domain_admin' });
  assert.deepEqual(outputLanding(sys, sys.outputs![0]), { mode: 'direct', text: 'Saved automatically to My files /reports as a dated markdown file when a run finishes.' });

  const dom = addOutput(team(), { kind: 'files', name: 'Shared report', folder: { path: '/reports', scope: 'domain' } });
  assert.match(outputLanding(dom, dom.outputs![0]).text, /Saved automatically to My files \/reports as a dated markdown file when a run finishes\. Sharing it to Domain files is then requested for you and waits for a domain admin’s approval\./);

  sys = { ...sys, safetyPreset: 'read-only' };
  assert.deepEqual(holdDecisionFor(sys.safetyPreset, 'upload_file'), { held: true, approverRole: 'admin' });
  const held = outputLanding(sys, sys.outputs![0]);
  assert.equal(held.mode, 'held');
  assert.match(held.text, /Not saved by a run: this team is read-only, so a run writes nothing by itself\. After a run, “Save now” saves it as you\./);
});

test('the agent is told whose final answer each output is, what it must contain, and that the SYSTEM saves it (consistent with its write tools)', () => {
  let sys = addOutput(team(), { kind: 'files', name: 'Verification report', folder: { path: '/reports', scope: 'personal' }, agent: 'writer' });
  sys = addOutput(sys, { kind: 'knowledge', name: 'Result', folder: { path: '/results', scope: 'personal' } });
  sys = addOutput(sys, { kind: 'data', name: 'Invoices', folder: { path: '/processed', scope: 'domain' }, agent: 'writer' });
  const brief = outputsBrief(sys);
  assert.match(brief, /The SYSTEM saves these results when the run finishes/);
  assert.match(brief, /you do not save it yourself/);
  assert.match(brief, /Your granted write tools are for any OTHER\nwork your instructions ask for/);
  assert.doesNotMatch(brief, /do NOT call a tool/, 'no blanket ban that contradicts granted write tools');
  assert.match(brief, /- "Verification report" \(file, folder "\/reports"\), from the final answer of agent writer: The complete document, in markdown\./);
  assert.match(brief, /- "Result" \(knowledge note, folder "\/results"\), from the final answer of the last agent of the run:/);
  // The Data format is generated from the declaration, and it is the rule the engine checks.
  assert.match(brief, /- "Invoices" \(dataset, folder "\/processed"\), from the final answer of agent writer: For the dataset "Invoices", its section of your final answer MUST contain exactly one JSON list/);
  assert.match(brief, /the SAME keys in every object/);
  // A producer that is no longer on the team does not leave the output unwritable.
  const orphan = { ...sys, agents: sys.agents.filter((a) => a.id !== 'writer'), entrypoint: 'reader' };
  assert.ok(toolsOf(withOutputTools(orphan), 'reader')!.includes('upload_file'));
});

test('OUTPUT CONTRACT: an agent that produces a document AND a dataset gives each its own section; one result = the whole answer', () => {
  let sys = addOutput(team(), { kind: 'files', name: 'Verification report', folder: { path: '/reports', scope: 'personal' }, agent: 'writer' });
  sys = addOutput(sys, { kind: 'data', name: 'Verified invoices', folder: { path: '/verification', scope: 'personal' }, agent: 'writer' });
  const brief = outputsBrief(sys, 'writer');
  assert.match(brief, /give each its own section/);
  assert.match(brief, /Under the line `=== OUTPUT: Verification report ===`/);
  assert.match(brief, /Under the line `=== OUTPUT: Verified invoices ===`/);
  // Per agent: another agent is not told about results it does not produce.
  assert.equal(outputsBrief(sys, 'reader'), '');
  // Read back: each result gets only its section.
  const answer = 'Done.\n=== OUTPUT: Verification report ===\n# Report\nAll lines match.\n\n=== OUTPUT: Verified invoices ===\n[{"invoice_no":"R-1","ok":true}]\n';
  assert.deepEqual(outputSection(answer, 'Verification report'), { ok: true, text: '# Report\nAll lines match.' });
  assert.deepEqual(outputSection(answer, 'Verified invoices'), { ok: true, text: '[{"invoice_no":"R-1","ok":true}]' });
  assert.deepEqual(outputSection(answer, 'Missing one'), { ok: false, reason: 'the agent\'s answer has no section named "Missing one"' }, 'never another result\'s text');
  // Twin: a single-result agent, and every answer without sections, is the result as a whole.
  const single = addOutput(team(), { kind: 'files', name: 'Report', folder: { path: '/reports', scope: 'personal' }, agent: 'writer' });
  assert.doesNotMatch(outputsBrief(single, 'writer'), /=== OUTPUT/);
  assert.deepEqual(outputSection('# Report\nfine', 'Report'), { ok: true, text: '# Report\nfine' });
});

test('the builder is told in advance what an output cannot do', () => {
  let sys = addOutput(team(), { kind: 'data', name: 'Invoices', folder: { path: '/processed', scope: 'domain' }, agent: 'writer' });
  const data = outputCaveats(sys, sys.outputs![0]);
  assert.match(data[0], /The instructions of writer do not ask for rows\./);
  assert.ok(data.some((c) => /replaces its rows/.test(c)), 'a run replaces the rows — said before it happens');
  assert.ok(data.some((c) => /documented and has a Silver or Gold version/.test(c)), 'the promotion gate of a dataset is named');

  // Once the producing agent is asked for a table, the note about the instructions goes away.
  sys = { ...sys, agents: sys.agents.map((a) => (a.id === 'writer' ? { ...a, agent_md: 'Return a JSON list with one object per invoice.' } : a)) };
  assert.ok(!outputCaveats(sys, sys.outputs![0]).some((c) => /ask for rows/.test(c)));

  const note = addOutput(team(), { kind: 'knowledge', name: 'Result', folder: { path: '/results', scope: 'personal' } });
  assert.match(outputCaveats(note, note.outputs![0])[0], /Knowledge search does not find notes yet/);
  const file = addOutput(team(), { kind: 'files', name: 'Report', folder: { path: '/reports', scope: 'personal' } });
  assert.deepEqual(outputCaveats(file, file.outputs![0]), []);
});

test('the producer is stored on the output and survives the YAML round trip', () => {
  const sys = addOutput(team(), { kind: 'files', name: 'Report', folder: { path: '/reports', scope: 'personal' }, agent: 'writer' });
  const back = parseSystem(serializeSystem(sys));
  assert.equal(back.outputs![0].agent, 'writer');
  assert.equal(addOutput(team(), { kind: 'files', name: 'R', folder: { path: '/r', scope: 'personal' }, agent: 'nobody' }).outputs![0].agent, undefined);
});

test('OUTPUT SECTIONS, robust: one output and an unmatched section = the whole answer; markers in code are examples; bold/heading markers count; duplicates are reported', () => {
  const misnamed = '=== OUTPUT: The report ===\n# Report';
  assert.deepEqual(outputSection(misnamed, 'Report', { onlyOutputOfProducer: true }), { ok: true, text: misnamed }, 'the producer\'s only result: the whole answer');
  assert.equal(outputSection(misnamed, 'Report').ok, false, 'among several: a typed miss');
  const inCode = 'Use this layout:\n```\n=== OUTPUT: Report ===\n...\n```\nThe report itself.';
  assert.deepEqual(outputSection(inCode, 'Report'), { ok: true, text: inCode }, 'a marker inside a code fence is an example, not a section');
  const styled = '### === OUTPUT: Report ===\nA\n**=== OUTPUT: Rows ===**\n[{"a":1}]';
  assert.deepEqual(outputSection(styled, 'Report'), { ok: true, text: 'A' });
  assert.deepEqual(outputSection(styled, 'Rows'), { ok: true, text: '[{"a":1}]' });
  const twice = '=== OUTPUT: Report ===\nA\n=== OUTPUT: Report ===\nB';
  assert.deepEqual(outputSection(twice, 'Report'), { ok: false, reason: 'the section "Report" appears 2 times in the agent\'s answer, so none was chosen' });
});
