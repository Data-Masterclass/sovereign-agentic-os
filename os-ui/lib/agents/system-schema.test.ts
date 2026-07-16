/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSystem, serializeSystem, assertGrantsWithinRole, downgradeGrantsForRole } from './system-schema.ts';

const VALID = `
version: "1"
system:
  name: Research Desk
  domain: sales
  visibility: Personal
entrypoint: supervisor
grants:
  tools: [metrics, retrieve, write_file]
  connections:
    - id: crm
      capability: Read
agents:
  - id: supervisor
    role: Routes work to specialists
    agent_md: "# Supervisor"
    memory_md: "# Memory"
    members: [researcher]
  - id: researcher
    role: Finds facts
    agent_md: "# Researcher"
    memory_md: ""
    tools: [retrieve]
edges:
  - { from: supervisor, to: researcher, type: supervise }
`;

test('parses a valid system.yaml', () => {
  const sys = parseSystem(VALID);
  assert.equal(sys.entrypoint, 'supervisor');
  assert.equal(sys.system.name, 'Research Desk');
  assert.equal(sys.system.visibility, 'Personal');
  assert.equal(sys.agents.length, 2);
  assert.deepEqual(sys.agents[0].members, ['researcher']);
  assert.equal(sys.edges[0].type, 'supervise');
  assert.deepEqual(sys.grants.connections, [{ id: 'crm', capability: 'Read' }]);
});

test('defaults state.channels to {messages: add_messages}', () => {
  const sys = parseSystem(VALID);
  assert.deepEqual(sys.state.channels, { messages: 'add_messages' });
});

test('defaults empty grants + routing overrides', () => {
  const sys = parseSystem(`
entrypoint: a
agents:
  - { id: a, role: r, agent_md: "", memory_md: "" }
`);
  assert.deepEqual(sys.grants.tools, []);
  assert.deepEqual(sys.grants.connections, []);
  assert.deepEqual(sys.routing.overrides, {});
});

test('rejects a non-mapping root', () => {
  assert.throws(() => parseSystem('- a\n- b'), /expected a mapping at the document root/);
});

test('rejects an invalid edge type with an exact error', () => {
  assert.throws(
    () =>
      parseSystem(`
entrypoint: a
agents: [{ id: a, role: r, agent_md: "", memory_md: "" }]
edges: [{ from: a, to: a, type: bogus }]
`),
    /edge 'a' -> 'a' has invalid type 'bogus' \(expected supervise\|handoff\)/,
  );
});

test('round-trips through serialize -> parse', () => {
  const sys = parseSystem(VALID);
  const yaml = serializeSystem(sys);
  const again = parseSystem(yaml);
  assert.deepEqual(again.agents.map((a) => a.id), ['supervisor', 'researcher']);
  assert.equal(again.entrypoint, 'supervisor');
});

// --- DATA-grant medallion layer -------------------------------------------------

test('data grant: layer omitted defaults to gold and stays out of the file (byte-stable)', () => {
  const sys = parseSystem(`
entrypoint: a
grants:
  data:
    - { id: ds_orders, capability: Read }
agents:
  - { id: a, role: r, agent_md: "", memory_md: "" }
`);
  // No layer key ⇒ gold (unset) — the historic/serving behaviour.
  assert.equal(sys.grants.data[0].layer, undefined);
  // Serialize does not introduce a `layer:` key for a gold/unset grant.
  assert.ok(!/layer:/.test(serializeSystem(sys)), 'gold grant serializes without a layer key');
});

test('data grant: a silver layer is parsed, preserved and round-trips', () => {
  const sys = parseSystem(`
entrypoint: a
grants:
  data:
    - { id: ds_orders, capability: Read, layer: silver }
agents:
  - { id: a, role: r, agent_md: "", memory_md: "" }
`);
  assert.equal(sys.grants.data[0].layer, 'silver');
  const yaml = serializeSystem(sys);
  assert.match(yaml, /layer: silver/);
  const again = parseSystem(yaml);
  assert.equal(again.grants.data[0].layer, 'silver');
});

test('data grant: an explicit gold layer is normalized away (byte-stable with unset)', () => {
  const withGold = parseSystem(`
entrypoint: a
grants: { data: [{ id: ds_x, capability: Read, layer: gold }] }
agents: [{ id: a, role: r, agent_md: "", memory_md: "" }]
`);
  const withUnset = parseSystem(`
entrypoint: a
grants: { data: [{ id: ds_x, capability: Read }] }
agents: [{ id: a, role: r, agent_md: "", memory_md: "" }]
`);
  assert.equal(withGold.grants.data[0].layer, undefined);
  assert.equal(serializeSystem(withGold), serializeSystem(withUnset));
});

test('an invalid data layer is rejected', () => {
  assert.throws(
    () =>
      parseSystem(`
entrypoint: a
grants: { data: [{ id: ds_x, capability: Read, layer: platinum }] }
agents: [{ id: a, role: r, agent_md: "", memory_md: "" }]
`),
    /invalid layer 'platinum'/,
  );
});

test('downgradeGrantsForRole preserves a data grant layer', () => {
  const sys = parseSystem(`
entrypoint: a
grants: { data: [{ id: ds_x, capability: Write-bounded, layer: silver }] }
agents: [{ id: a, role: r, agent_md: "", memory_md: "" }]
`);
  // A non-builder downgrade flips Write-bounded → Write-approval but keeps the layer.
  const down = downgradeGrantsForRole(sys, 'creator');
  assert.equal(down.grants.data[0].capability, 'Write-approval');
  assert.equal(down.grants.data[0].layer, 'silver');
});

test('ui.positions round-trips and is pruned to declared agents', () => {
  const sys = parseSystem(`
entrypoint: a
grants: { tools: [], connections: [] }
agents:
  - { id: a, role: r, agent_md: "", memory_md: "" }
  - { id: b, role: r, agent_md: "", memory_md: "" }
ui:
  positions:
    a: { x: 10, y: 20 }
    b: { x: 30, y: 40 }
    ghost: { x: 99, y: 99 }
`);
  // ghost has no agent → pruned on parse.
  assert.deepEqual(sys.ui?.positions, { a: { x: 10, y: 20 }, b: { x: 30, y: 40 } });
  // survives a serialize→parse round-trip.
  const again = parseSystem(serializeSystem(sys));
  assert.deepEqual(again.ui?.positions, { a: { x: 10, y: 20 }, b: { x: 30, y: 40 } });
});

test('no ui block is emitted when there are no positions (byte-stable legacy files)', () => {
  const sys = parseSystem(`
entrypoint: a
grants: { tools: [], connections: [] }
agents: [{ id: a, role: r, agent_md: "", memory_md: "" }]
`);
  assert.equal(sys.ui, undefined);
  assert.ok(!/\bui:/.test(serializeSystem(sys)), 'serialized file has no ui: key');
});

test('malformed ui positions are ignored (non-numeric / non-record)', () => {
  const sys = parseSystem(`
entrypoint: a
grants: { tools: [], connections: [] }
agents: [{ id: a, role: r, agent_md: "", memory_md: "" }]
ui: { positions: { a: { x: "nope", y: 5 } } }
`);
  assert.equal(sys.ui, undefined); // no valid positions → no ui block
});

test('MIGRATION: old string[] grants.data/knowledge coerce to {id, capability: Read}', () => {
  const sys = parseSystem(`
entrypoint: a
grants:
  data: [sales.orders, sales.customers]
  knowledge: [onboarding-flow]
agents:
  - { id: a, role: r, agent_md: "", memory_md: "" }
`);
  assert.deepEqual(sys.grants.data, [
    { id: 'sales.orders', capability: 'Read' },
    { id: 'sales.customers', capability: 'Read' },
  ]);
  assert.deepEqual(sys.grants.knowledge, [{ id: 'onboarding-flow', capability: 'Read' }]);
  assert.deepEqual(sys.grants.metrics, []); // new category defaults empty
});

test('MIGRATION: new {id, capability} shape + a mixed list both parse', () => {
  const sys = parseSystem(`
entrypoint: a
grants:
  data:
    - id: sales.orders
      capability: Write-approval
    - legacy.string.id
  metrics:
    - id: sales.orders.count
      capability: Read
agents:
  - { id: a, role: r, agent_md: "", memory_md: "" }
`);
  assert.deepEqual(sys.grants.data, [
    { id: 'sales.orders', capability: 'Write-approval' },
    { id: 'legacy.string.id', capability: 'Read' },
  ]);
  assert.deepEqual(sys.grants.metrics, [{ id: 'sales.orders.count', capability: 'Read' }]);
});

test('assertGrantsWithinRole: rejects Write-bounded below builder, allows at builder+', () => {
  const sys = parseSystem(`
entrypoint: a
grants:
  metrics:
    - id: m1
      capability: Write-bounded
agents:
  - { id: a, role: r, agent_md: "", memory_md: "" }
`);
  assert.throws(() => assertGrantsWithinRole(sys, 'creator'), /builder-only/i);
  assert.doesNotThrow(() => assertGrantsWithinRole(sys, 'builder'));
  assert.doesNotThrow(() => assertGrantsWithinRole(sys, 'admin'));
});

test('assertGrantsWithinRole: Read + Write-approval are allowed at creator', () => {
  const sys = parseSystem(`
entrypoint: a
grants:
  data:
    - id: d1
      capability: Write-approval
  connections:
    - id: crm
      capability: Read
agents:
  - { id: a, role: r, agent_md: "", memory_md: "" }
`);
  assert.doesNotThrow(() => assertGrantsWithinRole(sys, 'creator'));
});

test('grants round-trip through serialize (data/knowledge/metrics carry capability)', () => {
  const sys = parseSystem(`
entrypoint: a
grants:
  data:
    - id: d1
      capability: Read
  metrics:
    - id: m1
      capability: Write-approval
agents:
  - { id: a, role: r, agent_md: "", memory_md: "" }
`);
  const reparsed = parseSystem(serializeSystem(sys));
  assert.deepEqual(reparsed.grants.data, [{ id: 'd1', capability: 'Read' }]);
  assert.deepEqual(reparsed.grants.metrics, [{ id: 'm1', capability: 'Write-approval' }]);
});

test('assertGrantsWithinRole (DELTA): a PRE-EXISTING Write-bounded grant does not block a creator edit', () => {
  const prev = parseSystem(`
entrypoint: a
grants:
  data:
    - id: d1
      capability: Write-bounded
agents:
  - { id: a, role: r, agent_md: "", memory_md: "" }
`);
  // Same direct-write grant carried forward + an unrelated Read added → NOT blocked.
  const next = parseSystem(`
entrypoint: a
grants:
  data:
    - id: d1
      capability: Write-bounded
  knowledge:
    - id: k1
      capability: Read
agents:
  - { id: a, role: r, agent_md: "", memory_md: "" }
`);
  assert.doesNotThrow(() => assertGrantsWithinRole(next, 'creator', prev));

  // But INTRODUCING a NEW direct-write (different id) is still rejected.
  const escalated = parseSystem(`
entrypoint: a
grants:
  data:
    - id: d1
      capability: Write-bounded
    - id: d2
      capability: Write-bounded
agents:
  - { id: a, role: r, agent_md: "", memory_md: "" }
`);
  assert.throws(() => assertGrantsWithinRole(escalated, 'creator', prev), /d2/);
});

test('downgradeGrantsForRole: below builder, every Write-bounded → Write-approval across all four kinds', () => {
  const sys = parseSystem(`
entrypoint: a
grants:
  data:      [{ id: d1, capability: Write-bounded }]
  knowledge: [{ id: k1, capability: Write-bounded }]
  metrics:   [{ id: m1, capability: Write-bounded }]
  connections: [{ id: c1, capability: Write-bounded }, { id: c2, capability: Read }]
agents:
  - { id: a, role: r, agent_md: "", memory_md: "" }
`);
  const down = downgradeGrantsForRole(sys, 'creator');
  assert.equal(down.grants.data[0].capability, 'Write-approval');
  assert.equal(down.grants.knowledge[0].capability, 'Write-approval');
  assert.equal(down.grants.metrics[0].capability, 'Write-approval');
  assert.equal(down.grants.connections[0].capability, 'Write-approval');
  assert.equal(down.grants.connections[1].capability, 'Read'); // untouched
  // Pure: the input is not mutated.
  assert.equal(sys.grants.data[0].capability, 'Write-bounded');
});

test('downgradeGrantsForRole: builder+ is a no-op (direct write preserved)', () => {
  const sys = parseSystem(`
entrypoint: a
grants:
  data: [{ id: d1, capability: Write-bounded }]
agents:
  - { id: a, role: r, agent_md: "", memory_md: "" }
`);
  assert.equal(downgradeGrantsForRole(sys, 'builder').grants.data[0].capability, 'Write-bounded');
  assert.equal(downgradeGrantsForRole(sys, 'admin').grants.data[0].capability, 'Write-bounded');
});

// ── Wave 3: folder grants ───────────────────────────────────────────────────

test('folder grant round-trips through parse → serialize → parse', () => {
  const yaml = `
version: "1"
system: { name: T, domain: sales, visibility: Personal }
entrypoint: a
grants:
  data:
    - { id: d1, capability: Read }
    - { folder: { path: /contracts, scope: personal }, capability: Read }
  files:
    - { folder: { path: /invoices, scope: domain }, capability: Write-bounded }
agents:
  - { id: a, role: r, agent_md: "", memory_md: "" }
`;
  const sys = parseSystem(yaml);
  // The folder grant carries an empty id + a normalised {path,scope}.
  const fg = sys.grants.data.find((g) => g.folder)!;
  assert.equal(fg.id, '');
  assert.equal(fg.folder!.path, '/contracts');
  assert.equal(fg.folder!.scope, 'personal');
  assert.equal(sys.grants.files[0].folder!.path, '/invoices');
  assert.equal(sys.grants.files[0].folder!.scope, 'domain');
  assert.equal(sys.grants.files[0].capability, 'Write-bounded');
  // Item grant is still present alongside the folder grant.
  assert.ok(sys.grants.data.some((g) => g.id === 'd1' && !g.folder));
  // Byte-stable across a second round-trip.
  const round = serializeSystem(sys);
  assert.equal(serializeSystem(parseSystem(round)), round);
});

test('back-compat: a pre-Wave-3 system.yaml stays byte-stable (no grants.files key)', () => {
  const yaml = serializeSystem(parseSystem(`
version: "1"
system: { name: T, domain: sales, visibility: Personal }
entrypoint: a
grants:
  tools: [search_knowledge]
  data: [{ id: d1, capability: Read }]
agents:
  - { id: a, role: r, agent_md: "", memory_md: "" }
`));
  // No folder grant anywhere ⇒ the additive `files` key is NEVER emitted.
  assert.ok(!yaml.includes('files:'), 'grants.files omitted when empty');
  // And a re-parse + re-serialize is identical (stable).
  assert.equal(serializeSystem(parseSystem(yaml)), yaml);
});

test('a Write-bounded folder grant is builder-gated like an item grant', () => {
  const sys = parseSystem(`
entrypoint: a
grants:
  data:
    - { folder: { path: /x, scope: personal }, capability: Write-bounded }
agents:
  - { id: a, role: r, agent_md: "", memory_md: "" }
`);
  // A creator introducing a direct-write folder grant is rejected at the save boundary.
  assert.throws(() => assertGrantsWithinRole(sys, 'creator'), /Write-bounded|direct/i);
  // Runtime downgrade folds it to held-for-approval for a non-builder owner.
  assert.equal(downgradeGrantsForRole(sys, 'creator').grants.data[0].capability, 'Write-approval');
});
