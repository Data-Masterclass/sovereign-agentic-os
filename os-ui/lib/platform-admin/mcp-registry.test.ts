/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildMcpRegistry,
  buildOfficialSection,
  buildStackSection,
  buildSharedSection,
  buildPersonalSection,
  roleCanSee,
  STACK_MCP_SERVERS,
  OFFICIAL_PLATFORM_APIS,
  type OfficialToolInput,
  type StackServerInput,
  type OwnedMcpInput,
} from './mcp-registry.ts';

const TABS = ['software', 'data', 'science', 'knowledge', 'agents'] as const;

const OFFICIAL: OfficialToolInput[] = [
  { name: 'create_software', description: 'Create an app.', minRole: 'creator', tab: 'software' },
  { name: 'promote', description: 'Promote an app.', minRole: 'builder', tab: 'software' },
  { name: 'query_data', description: 'Query the marts.', minRole: 'creator', tab: 'data' },
  { name: 'search_knowledge', description: 'Retrieve knowledge.', minRole: 'creator', tab: 'knowledge' },
];

const OWNED: OwnedMcpInput[] = [
  {
    id: 'a1', source: 'app', name: 'Renewals MCP', description: 'renewals', endpoint: 'mcp://app-renewals',
    principal: 'app-renewals', tools: [{ name: 'list_renewals' }], visibility: 'Personal', owner: 'alice', domain: 'sales',
  },
  {
    id: 'a2', source: 'app', name: 'Pipeline MCP', description: 'pipeline', endpoint: 'mcp://app-pipeline',
    principal: 'app-pipeline', tools: [{ name: 'list_pipeline' }], visibility: 'Shared', owner: 'alice', domain: 'sales',
  },
  {
    id: 'c1', source: 'connection', name: 'Notion MCP', description: 'notion', endpoint: 'https://api.notion.com',
    principal: 'conn-notion', tools: [{ name: 'search' }], visibility: 'Certified', owner: 'bob', domain: 'ops',
  },
  {
    id: 'c2', source: 'connection', name: "Bob's Drive", description: 'drive', endpoint: 'mcp://conn-drive',
    principal: 'conn-drive', tools: [{ name: 'list_files' }], visibility: 'Personal', owner: 'bob', domain: 'ops',
  },
];

// -------------------------------------------------------------- role helper --
test('roleCanSee: rank floor mirrors the OS gate', () => {
  assert.equal(roleCanSee('creator', 'creator'), true);
  assert.equal(roleCanSee('creator', 'builder'), false);
  assert.equal(roleCanSee('admin', 'builder'), true);
});

// ------------------------------------------------------- official (primary) --
test('official section: overarching + one entry per tab, marked primary', () => {
  const s = buildOfficialSection('admin', OFFICIAL, TABS, OFFICIAL_PLATFORM_APIS);
  assert.equal(s.tier, 'official');
  assert.equal(s.primary, true);
  const over = s.entries.find((e) => e.id === 'os-mcp');
  assert.ok(over, 'has the overarching OS MCP');
  assert.equal(over?.endpoint, '/api/mcp');
  assert.equal(over?.importable, true);
  for (const tab of TABS) {
    const e = s.entries.find((x) => x.id === `os-mcp-${tab}`);
    assert.ok(e, `has the ${tab} tab entry`);
    assert.equal(e?.endpoint, `/api/mcp/${tab}`);
    assert.equal(e?.mcpTab, tab);
    assert.equal(e?.importable, true);
  }
  // Curated platform APIs are appended as API entries.
  assert.ok(s.entries.some((e) => e.kind === 'api' && e.endpoint === '/api/gateway'));
});

test('official section: role scoping hides tools below the caller floor', () => {
  const asParticipant = buildOfficialSection('creator', OFFICIAL, TABS);
  const overP = asParticipant.entries.find((e) => e.id === 'os-mcp')!;
  const namesP = overP.tools.map((t) => t.name);
  assert.ok(namesP.includes('create_software'));
  assert.ok(!namesP.includes('promote'), 'builder-floor tool hidden from participant');

  const asBuilder = buildOfficialSection('builder', OFFICIAL, TABS);
  const overB = asBuilder.entries.find((e) => e.id === 'os-mcp')!;
  assert.ok(overB.tools.map((t) => t.name).includes('promote'), 'builder sees promote');
  // Per-tab views inherit the same role filter.
  const softwareB = asBuilder.entries.find((e) => e.id === 'os-mcp-software')!;
  assert.deepEqual(
    softwareB.tools.map((t) => t.name).sort(),
    ['create_software', 'promote'],
  );
  const softwareP = asParticipant.entries.find((e) => e.id === 'os-mcp-software')!;
  assert.deepEqual(softwareP.tools.map((t) => t.name), ['create_software']);
});

// --------------------------------------------------------------- stack tools --
test('stack section: sources from the values.yaml mirror; live tools enrich live entry', () => {
  const live = [{ name: 'sovereign_query', description: 'live' }, { name: 'explain_query' }];
  const s = buildStackSection(STACK_MCP_SERVERS, live);
  assert.equal(s.tier, 'stack');
  const trino = s.entries.find((e) => e.id === 'stack-sovereign_query')!;
  assert.equal(trino.importable, false, 'stack tools are gateway-fronted, not per-user importable');
  assert.deepEqual(trino.tools.map((t) => t.name), ['sovereign_query', 'explain_query']);
  // A not-yet-live server keeps its (empty) static tools + status badge.
  const superset = s.entries.find((e) => e.id === 'stack-superset')!;
  assert.equal(superset.live, false);
  assert.equal(superset.tools.length, 0);
  assert.equal(superset.scope, 'coming online');
});

test('stack section: without live tools, the live entry falls back to declared tools', () => {
  const s = buildStackSection(STACK_MCP_SERVERS, []);
  const trino = s.entries.find((e) => e.id === 'stack-sovereign_query')!;
  assert.deepEqual(trino.tools.map((t) => t.name), ['sovereign_query']);
});

// ------------------------------------------------------- shared / personal --
test('shared section: only Shared + Certified, never Personal', () => {
  const s = buildSharedSection(OWNED);
  const names = s.entries.map((e) => e.name).sort();
  assert.deepEqual(names, ['Notion MCP', 'Pipeline MCP']);
  assert.ok(!s.entries.some((e) => e.visibility === 'Personal'));
});

test('personal section: only the caller-owned Personal tier', () => {
  const forAlice = buildPersonalSection(OWNED, 'alice');
  assert.deepEqual(forAlice.entries.map((e) => e.name), ['Renewals MCP']);
  // Bob's personal MCP is not the caller's, so it is excluded even though present.
  const forBob = buildPersonalSection(OWNED, 'bob');
  assert.deepEqual(forBob.entries.map((e) => e.name), ["Bob's Drive"]);
});

// ------------------------------------------------------------------ assemble --
test('buildMcpRegistry: exactly four sections in canonical order', () => {
  const reg = buildMcpRegistry({
    role: 'admin', userId: 'alice', officialTools: OFFICIAL, tabs: TABS,
    officialApis: OFFICIAL_PLATFORM_APIS, stackServers: STACK_MCP_SERVERS,
    liveGatewayTools: [], ownedMcps: OWNED,
  });
  assert.deepEqual(reg.sections.map((s) => s.tier), ['official', 'stack', 'shared', 'personal']);
});

test('buildMcpRegistry: empty owned lists yield graceful empty sections, never a crash', () => {
  const reg = buildMcpRegistry({
    role: 'creator', userId: 'nobody', officialTools: [], tabs: TABS,
    stackServers: [], ownedMcps: [],
  });
  const shared = reg.sections.find((s) => s.tier === 'shared')!;
  const personal = reg.sections.find((s) => s.tier === 'personal')!;
  assert.equal(shared.entries.length, 0);
  assert.equal(personal.entries.length, 0);
  // Official still renders the overarching + per-tab entries even with no tools.
  const official = reg.sections.find((s) => s.tier === 'official')!;
  assert.ok(official.entries.some((e) => e.id === 'os-mcp'));
});
