/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSystem, serializeSystem } from './system-schema.ts';
import {
  setAgentRole, setAgentInstructions, setSystemTools, addSystemTool, removeSystemTool,
  addSimpleAgent, moveAgent, nextAgentId, addArtifactGrant, removeArtifactGrant,
  addAgentTool, removeAgentTool, removeAgentSimple, setArtifactGrant, setDataGrantLayer,
  setFolderGrant, removeFolderGrant, setFolderGrantLevel, linearizeChain,
} from './simple-edit.ts';
import { toolsForCapabilityChipsInPool } from './capability-tools.ts';
import { instructionsOf } from './agent-md.ts';
import { compile } from './langgraph-compile.ts';

const BASE = `
system: { name: Desk, domain: sales, visibility: Personal }
entrypoint: analyst
grants: { tools: [search_knowledge, query_data] }
agents:
  - { id: analyst, role: Analyzes sources, agent_md: "# analyst\\n\\nOld instructions.", memory_md: "" }
  - { id: writer, role: Writes it up, agent_md: "# writer\\n\\nWrites.", memory_md: "" }
`;

test('setAgentInstructions writes the SAME agent_md a Developer AGENT.md edit would', () => {
  const sys = parseSystem(BASE);
  // Simple mode: the textarea shows only the body...
  assert.equal(instructionsOf(sys.agents[0].agent_md), 'Old instructions.');
  const next = setAgentInstructions(sys, 'analyst', 'Fresh instructions.');
  // ...and writing back keeps the heading — i.e. the exact file Developer mode holds.
  assert.equal(next.agents[0].agent_md, '# analyst\n\nFresh instructions.');
  // Developer mode edits agent_md directly to the same string — identical system.yaml.
  const dev = structuredClone(sys);
  dev.agents[0].agent_md = '# analyst\n\nFresh instructions.';
  assert.equal(serializeSystem(next), serializeSystem(dev), 'same system.yaml as the Developer edit');
});

test('setSystemTools writes the SAME grants.tools the Grants panel would', () => {
  const sys = parseSystem(BASE);
  const simple = setSystemTools(sys, ['search_knowledge', 'query_data', 'list_datasets']);
  // Developer Grants panel pushes onto grants.tools directly.
  const dev = structuredClone(sys);
  dev.grants.tools.push('list_datasets');
  assert.equal(serializeSystem(simple), serializeSystem(dev), 'identical system.yaml');
});

test('addSystemTool is idempotent and removeSystemTool also un-narrows agents', () => {
  let sys = parseSystem(BASE);
  sys = addSystemTool(sys, 'query_data'); // already present
  assert.deepEqual(sys.grants.tools, ['search_knowledge', 'query_data']);
  // narrow an agent, then remove the tool system-wide
  sys.agents[1].tools = ['query_data'];
  const removed = removeSystemTool(sys, 'query_data');
  assert.ok(!removed.grants.tools.includes('query_data'));
  assert.ok(!(removed.agents[1].tools ?? []).includes('query_data'), 'narrowing dropped too');
});

test('setSystemTools de-duplicates', () => {
  const sys = parseSystem(BASE);
  const out = setSystemTools(sys, ['a', 'a', 'b', 'b', 'a']);
  assert.deepEqual(out.grants.tools, ['a', 'b']);
});

test('addSimpleAgent adds a plain agent; first-ever agent becomes START', () => {
  const empty = parseSystem('system: { name: X, domain: d, visibility: Personal }\nentrypoint: ""\ngrants: {}\nagents: []');
  const one = addSimpleAgent(empty, { role: 'Greeter', instructions: 'Say hi.' });
  assert.equal(one.agents.length, 1);
  assert.equal(one.entrypoint, one.agents[0].id, 'first agent auto-becomes START');
  assert.equal(instructionsOf(one.agents[0].agent_md), 'Say hi.');
  // Adding a second does NOT steal the entrypoint.
  const two = addSimpleAgent(one, { role: 'Writer' });
  assert.equal(two.entrypoint, one.agents[0].id);
  assert.equal(two.agents.length, 2);
});

test('addSimpleAgent uses the same agentN naming as the canvas', () => {
  const sys = parseSystem(BASE);
  assert.equal(nextAgentId(sys), 'agent3');
  const next = addSimpleAgent(sys, {});
  assert.ok(next.agents.some((a) => a.id === 'agent3'));
});

test('addSimpleAgent rejects a duplicate id', () => {
  const sys = parseSystem(BASE);
  assert.throws(() => addSimpleAgent(sys, { id: 'analyst' }), /already exists/);
});

test('setAgentRole edits only the role', () => {
  const sys = parseSystem(BASE);
  const next = setAgentRole(sys, 'writer', 'Chief scribe');
  assert.equal(next.agents[1].role, 'Chief scribe');
  assert.equal(next.agents[1].agent_md, sys.agents[1].agent_md, 'instructions untouched');
});

test('moveAgent reorders and clamps at the ends', () => {
  const sys = parseSystem(BASE);
  const down = moveAgent(sys, 'analyst', 1);
  assert.deepEqual(down.agents.map((a) => a.id), ['writer', 'analyst']);
  // clamp: moving the first up is a no-op
  const up = moveAgent(sys, 'analyst', -1);
  assert.deepEqual(up.agents.map((a) => a.id), ['analyst', 'writer']);
});

test('addArtifactGrant grants Data at Read and is idempotent', () => {
  const sys = parseSystem(BASE);
  const one = addArtifactGrant(sys, 'data', 'ds_campaigns');
  assert.deepEqual(one.grants.data, [{ id: 'ds_campaigns', capability: 'Read' }]);
  // idempotent — a second add does not duplicate
  const two = addArtifactGrant(one, 'data', 'ds_campaigns');
  assert.equal(two.grants.data.length, 1);
});

test('addArtifactGrant / removeArtifactGrant round-trip on Knowledge', () => {
  const sys = parseSystem(BASE);
  const added = addArtifactGrant(sys, 'knowledge', 'wf_playbook');
  assert.deepEqual(added.grants.knowledge, [{ id: 'wf_playbook', capability: 'Read' }]);
  const removed = removeArtifactGrant(added, 'knowledge', 'wf_playbook');
  assert.deepEqual(removed.grants.knowledge, []);
  // removing a non-grant is a no-op
  assert.deepEqual(removeArtifactGrant(sys, 'data', 'nope').grants.data, sys.grants.data);
});

test('every Simple edit leaves the input untouched (immutability, for undo/redo)', () => {
  const sys = parseSystem(BASE);
  const snapshot = serializeSystem(sys);
  setAgentRole(sys, 'analyst', 'x');
  setAgentInstructions(sys, 'analyst', 'y');
  setSystemTools(sys, ['z']);
  addSimpleAgent(sys, { role: 'q' });
  moveAgent(sys, 'analyst', 1);
  assert.equal(serializeSystem(sys), snapshot, 'input never mutated');
});

test('addAgentTool grants a tool to ONLY the target agent, not inheriting siblings', () => {
  const sys = parseSystem(BASE); // analyst + writer both inherit [search_knowledge, query_data]
  const next = addAgentTool(sys, 'writer', 'author_knowledge');
  const writer = next.agents.find((a) => a.id === 'writer')!;
  const analyst = next.agents.find((a) => a.id === 'analyst')!;
  assert.ok(writer.tools!.includes('author_knowledge'), 'target agent gets the tool');
  assert.ok(!analyst.tools!.includes('author_knowledge'), 'sibling does NOT inherit it (the bug)');
  assert.ok(next.grants.tools.includes('author_knowledge'), 'pool contains it (agent tools ⊆ grants)');
});

test('removeAgentTool removes from one agent and prunes the pool only when unused', () => {
  const sys = parseSystem(BASE);
  const one = removeAgentTool(sys, 'writer', 'query_data');
  assert.ok(!one.agents.find((a) => a.id === 'writer')!.tools!.includes('query_data'));
  assert.ok(one.agents.find((a) => a.id === 'analyst')!.tools!.includes('query_data'), 'still used → kept');
  assert.ok(one.grants.tools.includes('query_data'));
  const gone = removeAgentTool(one, 'analyst', 'query_data');
  assert.ok(!gone.grants.tools.includes('query_data'), 'pruned from pool when no agent uses it');
});

test('removeAgentSimple deletes any agent incl. START, reassigning the entrypoint', () => {
  const sys = parseSystem(BASE); // entrypoint = analyst
  const next = removeAgentSimple(sys, 'analyst');
  assert.ok(!next.agents.some((a) => a.id === 'analyst'));
  assert.equal(next.entrypoint, 'writer', 'START handed to the remaining agent');
  const empty = removeAgentSimple(next, 'writer');
  assert.equal(empty.agents.length, 0);
  assert.equal(empty.entrypoint, '');
});

// --- DATA-grant medallion layer -------------------------------------------------

test('setArtifactGrant on data carries the chosen layer; gold stays unset (byte-stable)', () => {
  const sys = parseSystem(BASE);
  // Default (gold) → no layer key on the grant.
  const gold = setArtifactGrant(sys, 'data', 'ds_orders', false);
  assert.equal(gold.grants.data[0].id, 'ds_orders');
  assert.equal(gold.grants.data[0].layer, undefined);
  // Silver → recorded on the grant.
  const silver = setArtifactGrant(sys, 'data', 'ds_orders', false, 'silver');
  assert.equal(silver.grants.data[0].layer, 'silver');
});

test('re-toggling Read/Write keeps a previously-picked data layer', () => {
  let sys = setArtifactGrant(parseSystem(BASE), 'data', 'ds_orders', false, 'bronze');
  assert.equal(sys.grants.data[0].layer, 'bronze');
  // Flip to write (default gold arg) — the stored layer must survive.
  sys = setArtifactGrant(sys, 'data', 'ds_orders', true);
  assert.equal(sys.grants.data[0].capability, 'Write-bounded');
  assert.equal(sys.grants.data[0].layer, 'bronze', 'layer preserved across an access toggle');
});

test('non-data kinds ignore the layer argument', () => {
  const sys = setArtifactGrant(parseSystem(BASE), 'knowledge', 'wf_playbook', false, 'silver');
  assert.equal(sys.grants.knowledge[0].id, 'wf_playbook');
  assert.equal((sys.grants.knowledge[0] as { layer?: string }).layer, undefined);
});

test('setDataGrantLayer sets/clears the layer only on data grants', () => {
  const base = setArtifactGrant(parseSystem(BASE), 'data', 'ds_orders', false);
  const silver = setDataGrantLayer(base, 'ds_orders', 'silver');
  assert.equal(silver.grants.data[0].layer, 'silver');
  // Back to gold clears the key so the file stays byte-stable.
  const gold = setDataGrantLayer(silver, 'ds_orders', 'gold');
  assert.equal(gold.grants.data[0].layer, undefined);
  assert.ok(!/layer:/.test(serializeSystem(gold)));
});

test('setDataGrantLayer throws for an ungranted dataset', () => {
  assert.throws(() => setDataGrantLayer(parseSystem(BASE), 'ds_missing', 'silver'), /not a granted dataset/);
});

// ── Wave 3: folder grants ───────────────────────────────────────────────────

test('setFolderGrant adds a folder grant AND provisions the SAME tools an item grant would', () => {
  const next = setFolderGrant(parseSystem(BASE), 'data', { path: '/contracts', scope: 'personal' }, false);
  const fg = next.grants.data.find((g) => g.folder)!;
  assert.equal(fg.id, '');
  assert.equal(fg.folder!.path, '/contracts');
  assert.equal(fg.capability, 'Read');
  // Same read tools an item grant of data would auto-provision (from capability-tools).
  for (const t of ['query_data', 'list_datasets', 'get_dataset', 'profile_dataset']) {
    assert.ok(next.grants.tools.includes(t), `provisions ${t}`);
  }
});

test('setFolderGrant is idempotent + a write folder grant lifts read-only → read-bounded', () => {
  let sys = parseSystem(BASE);
  sys = setFolderGrant(sys, 'files', { path: '/invoices', scope: 'domain' }, true);
  assert.equal(sys.safetyPreset, 'read-bounded');
  assert.ok(sys.grants.tools.includes('upload_file'));
  // Re-granting the same folder updates the SAME entry in place (no duplicate).
  sys = setFolderGrant(sys, 'files', { path: '/invoices', scope: 'domain' }, false);
  assert.equal(sys.grants.files.filter((g) => g.folder).length, 1);
  assert.equal(sys.grants.files[0].capability, 'Read');
});

test('removeFolderGrant drops the folder grant + strips write tools when nothing writes', () => {
  let sys = setFolderGrant(parseSystem(BASE), 'files', { path: '/invoices', scope: 'domain' }, true);
  assert.ok(sys.grants.tools.includes('upload_file'));
  sys = removeFolderGrant(sys, 'files', { path: '/invoices', scope: 'domain' });
  assert.equal(sys.grants.files.length, 0);
  assert.ok(!sys.grants.tools.includes('upload_file'), 'write tool stripped when no grant writes');
});

test('removeArtifactGrant of an unrelated grant does NOT strip a live files-folder write', () => {
  // A team with a WRITE files-folder grant (→ upload_file) plus a data item grant.
  let sys = parseSystem(BASE);
  sys = setFolderGrant(sys, 'files', { path: '/invoices', scope: 'domain' }, true);
  sys = setArtifactGrant(sys, 'data', 'ds_sales', false); // unrelated read grant
  assert.ok(sys.grants.tools.includes('upload_file'), 'files write tool provisioned');
  // Removing the unrelated DATA grant must not touch the files write tool.
  sys = removeArtifactGrant(sys, 'data', 'ds_sales');
  assert.ok(
    sys.grants.tools.includes('upload_file'),
    'upload_file survives while a write files-folder grant remains',
  );
  // And removing the files folder grant DOES strip it (files use removeFolderGrant).
  sys = removeFolderGrant(sys, 'files', { path: '/invoices', scope: 'domain' });
  assert.ok(!sys.grants.tools.includes('upload_file'), 'stripped once no files grant writes');
});

test('setFolderGrantLevel can set a Files-folder write; downgrade strips the write tool', () => {
  let sys = parseSystem(BASE);
  sys = setFolderGrantLevel(sys, 'files', { path: '/invoices', scope: 'domain' }, 'read-write');
  assert.ok(sys.grants.tools.includes('upload_file'), 'read-write files folder provisions upload_file');
  assert.equal(sys.grants.files[0].capability, 'Write-bounded');
  // Downgrade the ONLY files grant to read-only → upload_file gone (files carry no item list).
  sys = setFolderGrantLevel(sys, 'files', { path: '/invoices', scope: 'domain' }, 'read-only');
  assert.ok(!sys.grants.tools.includes('upload_file'), 'downgrade to read-only strips upload_file');
});

test('end-to-end: a Write-bounded data+files team, narrowed via chips, keeps read AND write tools', () => {
  // Team granted data (item) + files (folder) at read+write.
  let sys = parseSystem(BASE);
  sys = setArtifactGrant(sys, 'data', 'ds_sales', true);
  sys = setFolderGrant(sys, 'files', { path: '/invoices', scope: 'domain' }, true);
  // Simulate the Design capability picker narrowing an agent to data + files chips.
  const narrowed = toolsForCapabilityChipsInPool(['read-data', 'create-files'], sys.grants.tools);
  sys.agents[0].tools = narrowed;
  const agentTools = new Set(sys.agents[0].tools);
  // The agent can now call BOTH the read and the granted write tools.
  assert.ok(agentTools.has('query_data'), 'query_data present');
  assert.ok(agentTools.has('create_dataset'), 'create_dataset present');
  assert.ok(agentTools.has('get_file'), 'get_file present');
  assert.ok(agentTools.has('upload_file'), 'upload_file present');
  // Subset invariant: agent tools ⊆ system.grants.tools.
  const pool = new Set(sys.grants.tools);
  for (const t of sys.agents[0].tools!) assert.ok(pool.has(t), `${t} ⊆ grants.tools`);
});

test('end-to-end: a read-only team, narrowed via chips, gets read tools and NO write tools', () => {
  let sys = parseSystem(BASE);
  sys = setArtifactGrant(sys, 'data', 'ds_sales', false);
  sys = setFolderGrant(sys, 'files', { path: '/invoices', scope: 'domain' }, false);
  const narrowed = toolsForCapabilityChipsInPool(['read-data', 'create-files'], sys.grants.tools);
  const agentTools = new Set(narrowed);
  assert.ok(agentTools.has('query_data') && agentTools.has('get_file'), 'read tools present');
  assert.ok(!agentTools.has('create_dataset'), 'no data write tool');
  assert.ok(!agentTools.has('upload_file'), 'no files write tool');
});

test('setFolderGrant is a pure edit (input untouched)', () => {
  const base = parseSystem(BASE);
  const before = serializeSystem(base);
  setFolderGrant(base, 'knowledge', { path: '/policies', scope: 'personal' }, false);
  assert.equal(serializeSystem(base), before);
});

// ── Simple-mode LINEAR auto-connect ──────────────────────────────────────────

const chainEdges = (sys: ReturnType<typeof parseSystem>) =>
  sys.edges.filter((e) => e.type === 'handoff').map((e) => `${e.from}->${e.to}`);

test('linearizeChain wires agents in declared order as a handoff chain', () => {
  const sys = parseSystem(BASE); // analyst, writer
  const chained = linearizeChain(sys);
  assert.deepEqual(chainEdges(chained), ['analyst->writer']);
});

test('linearizeChain replaces stale handoffs and keeps supervise edges', () => {
  const sys = parseSystem(`
system: { name: T, domain: d, visibility: Personal }
entrypoint: a
grants: {}
agents:
  - { id: a, role: A, agent_md: "", memory_md: "", members: [b] }
  - { id: b, role: B, agent_md: "", memory_md: "" }
  - { id: c, role: C, agent_md: "", memory_md: "" }
edges:
  - { from: a, to: b, type: supervise }
  - { from: c, to: a, type: handoff }
`);
  const chained = linearizeChain(sys);
  // Supervise preserved; handoffs rebuilt as a->b->c in declared order.
  assert.ok(chained.edges.some((e) => e.from === 'a' && e.to === 'b' && e.type === 'supervise'));
  assert.deepEqual(chainEdges(chained), ['a->b', 'b->c']);
});

test('addSimpleAgent auto-chains the new agent onto the end', () => {
  const sys = parseSystem(BASE);
  const next = addSimpleAgent(sys, { role: 'Reviewer' }); // agent3
  assert.deepEqual(chainEdges(next), ['analyst->writer', `writer->${next.agents[2].id}`]);
});

test('removeAgentSimple re-chains the remaining agents (no gap)', () => {
  let sys = parseSystem(BASE);
  sys = addSimpleAgent(sys, { id: 'third', role: 'Third' }); // analyst->writer->third
  const next = removeAgentSimple(sys, 'writer');
  assert.deepEqual(chainEdges(next), ['analyst->third']);
});

test('moveAgent re-wires the chain to the new order', () => {
  const sys = parseSystem(BASE); // analyst->writer
  const moved = moveAgent(sys, 'writer', -1); // writer, analyst
  assert.deepEqual(moved.agents.map((a) => a.id), ['writer', 'analyst']);
  assert.deepEqual(chainEdges(moved), ['writer->analyst']);
});

test('linearizeChain preserves an existing consecutive handoff `when` label', () => {
  const sys = parseSystem(`
system: { name: T, domain: d, visibility: Personal }
entrypoint: a
grants: {}
agents:
  - { id: a, role: A, agent_md: "", memory_md: "" }
  - { id: b, role: B, agent_md: "", memory_md: "" }
edges:
  - { from: a, to: b, type: handoff, when: "A complete" }
`);
  const chained = linearizeChain(sys);
  const e = chained.edges.find((x) => x.from === 'a' && x.to === 'b')!;
  assert.equal(e.when, 'A complete', 'label carried through the re-chain');
});

// --- Full inheritance: a dataset granted in Define reaches an EARLIER-added agent ----
// The runtime data-plane deny root cause was NOT the OPA/DLS layer (a granted dataset
// authorizes for a runner who can see it) but that a fresh agent could be FROZEN to a
// tool snapshot taken before the dataset grant — so its node never saw query_data/
// get_dataset and the granted dataset was unusable for it. A freshly added agent must
// therefore INHERIT the full, growing grant pool (agent.tools stays undefined), so a
// data grant added LATER in Define reaches it. This is what the run path compiles into
// the node's tool set (`compile()` → node.tools = agent.tools ?? grants.tools).

/** The full BASE (blank pool) + one added agent whose tools stay undefined (inherits). */
const INHERIT_BASE = `
system: { name: Team, domain: sales, visibility: Personal }
grants: { tools: [] }
`;

test('a fresh agent (no explicit tools) inherits a dataset granted LATER in Define', () => {
  // 1) Add the agent FIRST (Design), when the pool has no data tools yet.
  let sys = addSimpleAgent(parseSystem(INHERIT_BASE), { role: 'Analyst', instructions: 'Analyze.' });
  const agentId = sys.agents[sys.agents.length - 1].id;
  assert.equal(sys.agents[0].tools, undefined, 'a fresh agent carries NO explicit tools (full inheritance)');

  // 2) THEN grant a dataset in Define — this grows the team pool with the data tools.
  sys = setArtifactGrant(sys, 'data', 'ds_granted', false);
  const pool = new Set(sys.grants.tools);
  for (const t of ['query_data', 'list_datasets', 'get_dataset', 'profile_dataset']) {
    assert.ok(pool.has(t), `Define data grant provisions ${t} into the team pool`);
  }

  // 3) The agent STILL has no explicit tools, so the run path compiles the FULL pool
  //    onto its node — query_data/get_dataset are now authorized for its run.
  assert.equal(
    sys.agents.find((a) => a.id === agentId)!.tools,
    undefined,
    'the earlier-added agent is not frozen — it still inherits the whole pool',
  );
  const node = compile(sys).nodes.find((n) => n.id === agentId)!;
  for (const t of ['query_data', 'get_dataset', 'list_datasets', 'profile_dataset']) {
    assert.ok(node.tools.includes(t), `run-time node holds ${t} from the inherited pool`);
  }
});

test('addSystemTool grows the pool WITHOUT freezing an inheriting agent (template add-path)', () => {
  // The Design template add-path adds each suggestedTool to the POOL (addSystemTool),
  // leaving the new agent inheriting — so a later data grant is not missed. Contrast
  // with addAgentTool, which freezes the agent to the current pool snapshot.
  let sys = addSimpleAgent(parseSystem(INHERIT_BASE), { role: 'Analyst', instructions: 'x' });
  const agentId = sys.agents[0].id;
  // Template suggests query_data → goes into the pool only (agent stays inheriting).
  sys = addSystemTool(sys, 'query_data');
  assert.ok(sys.grants.tools.includes('query_data'), 'suggested tool lands in the team pool');
  assert.equal(sys.agents[0].tools, undefined, 'the new agent is NOT frozen — still inherits');

  // A dataset granted afterwards still reaches the agent (proves no snapshot freeze).
  sys = setArtifactGrant(sys, 'data', 'ds_later', false);
  const node = compile(sys).nodes.find((n) => n.id === agentId)!;
  assert.ok(node.tools.includes('get_dataset'), 'a later Define grant reaches the inheriting agent');
});

test('CONTRAST: addAgentTool freezes an agent so a LATER grant is missed (why we avoid it on add)', () => {
  // This pins the exact failure the fix avoids: freezing the agent to the pool snapshot
  // means a dataset granted afterwards never reaches its node → effective run-time deny.
  let sys = addSimpleAgent(parseSystem(INHERIT_BASE), { role: 'Analyst', instructions: 'x' });
  const agentId = sys.agents[0].id;
  sys = addAgentTool(sys, agentId, 'search_knowledge'); // freezes the agent to the pool snapshot
  assert.ok(Array.isArray(sys.agents[0].tools), 'addAgentTool makes the agent tools explicit (frozen)');

  sys = setArtifactGrant(sys, 'data', 'ds_missed', false); // grows the pool AFTER the freeze
  const node = compile(sys).nodes.find((n) => n.id === agentId)!;
  assert.ok(!node.tools.includes('get_dataset'), 'a frozen agent MISSES the later data grant (the bug we fixed on add)');
});
