/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Tests for the tool-catalog lib + source tripwires for the route and the Grants UI.
 *
 * Route handlers can't be imported under `node --test` (they pull `next`), so the
 * route's auth/role gate is verified by reading the source — the same convention
 * as `security-route-guards.test.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { buildCatalog, buildFullCatalog } from './tool-catalog.ts';

const OSUI = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p: string) => readFileSync(resolve(OSUI, p), 'utf8');

// --- catalog logic -----------------------------------------------------------

test('buildCatalog: creator does NOT see approve_promotion (builder-floor)', () => {
  const catalog = buildCatalog('creator');
  const names = catalog.map((t) => t.name);
  assert.ok(!names.includes('approve_promotion'), 'approve_promotion must be invisible to a creator');
});

test('buildCatalog: creator does NOT see publish_knowledge (builder-floor)', () => {
  const catalog = buildCatalog('creator');
  assert.ok(!catalog.some((t) => t.name === 'publish_knowledge'), 'publish_knowledge is builder-floor');
});

test('buildCatalog: creator sees core read + write tools', () => {
  const catalog = buildCatalog('creator');
  const names = catalog.map((t) => t.name);
  assert.ok(names.includes('query_data'), 'creator can grant query_data');
  assert.ok(names.includes('search_knowledge'), 'creator can grant search_knowledge');
  assert.ok(names.includes('create_dataset'), 'creator can grant create_dataset');
  assert.ok(names.includes('upload_file'), 'creator can grant upload_file');
});

test('buildCatalog: approve_promotion is domain_admin-floor (builder cannot, domain_admin can)', () => {
  // Approving Personal→Shared now requires domain_admin+, so a plain builder no
  // longer sees approve_promotion; a domain_admin does.
  const builderCatalog = buildCatalog('builder');
  assert.ok(
    !builderCatalog.some((t) => t.name === 'approve_promotion'),
    'a plain builder can no longer grant approve_promotion',
  );
  const domainAdminCatalog = buildCatalog('domain_admin');
  assert.ok(
    domainAdminCatalog.some((t) => t.name === 'approve_promotion'),
    'a domain_admin can grant approve_promotion',
  );
});

test('buildCatalog: builder catalog is a strict superset of creator catalog', () => {
  const creatorNames = new Set(buildCatalog('creator').map((t) => t.name));
  const builderNames = new Set(buildCatalog('builder').map((t) => t.name));
  for (const name of creatorNames) {
    assert.ok(builderNames.has(name), `${name} in creator must also be in builder`);
  }
  assert.ok(builderNames.size > creatorNames.size, 'builder sees at least one tool more than creator');
});

test('buildCatalog: requires_approval is true for write tools and false for read tools', () => {
  const catalog = buildCatalog('creator');
  const createDataset = catalog.find((t) => t.name === 'create_dataset');
  assert.ok(createDataset, 'create_dataset must be in creator catalog');
  assert.equal(createDataset!.requires_approval, true, 'create_dataset is a write tool → requires_approval');

  const queryData = catalog.find((t) => t.name === 'query_data');
  assert.ok(queryData, 'query_data must be in creator catalog');
  assert.equal(queryData!.requires_approval, false, 'query_data is a read tool → no approval');

  const searchKnowledge = catalog.find((t) => t.name === 'search_knowledge');
  assert.ok(searchKnowledge, 'search_knowledge must be in creator catalog');
  assert.equal(searchKnowledge!.requires_approval, false, 'search_knowledge is read → no approval');
});

test('buildCatalog: every entry carries name, tab, minRole, description, requires_approval', () => {
  const catalog = buildCatalog('creator');
  assert.ok(catalog.length > 0, 'catalog is non-empty');
  for (const entry of catalog) {
    assert.equal(typeof entry.name, 'string', `${entry.name}: name is string`);
    assert.ok(entry.name.length > 0, `${entry.name}: name is non-empty`);
    assert.equal(typeof entry.tab, 'string', `${entry.name}: tab is string`);
    assert.equal(typeof entry.minRole, 'string', `${entry.name}: minRole is string`);
    assert.equal(typeof entry.description, 'string', `${entry.name}: description is string`);
    assert.equal(typeof entry.requires_approval, 'boolean', `${entry.name}: requires_approval is boolean`);
  }
});

// --- route source tripwires --------------------------------------------------

test('TOOL-CATALOG ROUTE: gates on requireUser() from session (not body)', () => {
  const src = read('app/api/agents/tool-catalog/route.ts');
  assert.match(src, /await requireUser\(\)/, 'catalog route must call requireUser');
  // The tagged 401 pattern mirrors the rest of the user-gated GET fleet.
  assert.match(src, /status\?: number \}\)\.status \?\? 401/, 'route returns 401 for anon');
  // Principal must NEVER come from the request body — role-scoping happens on user.role
  assert.doesNotMatch(src, /body\.role\b/, 'role must not be read from body');
  assert.doesNotMatch(src, /body\.user\b/, 'user must not be read from body');
});

// --- Grants UI source tripwire -----------------------------------------------

test('GrantsRouting: picker fetches the tool catalog; free-text fallback is gone', () => {
  const src = read('components/agents/GrantsRouting.tsx');
  assert.match(src, /\/api\/agents\/tool-catalog/, 'component fetches from the catalog endpoint');
  // Canonical MCP names written into grants, not arbitrary free-text.
  assert.doesNotMatch(src, /add a tool, e\.g\. retrieve/, 'free-text placeholder must be removed');
});

test('GrantsRouting: emits canonical names — writes t.name into grants.tools', () => {
  const src = read('components/agents/GrantsRouting.tsx');
  // The picker writes t.name (the canonical MCP name) not a custom string.
  assert.match(src, /grants\.tools\.push\(t\.name\)|grants\.tools\.includes\(t\.name\)/, 'uses t.name for canonical grants');
});

// --- buildFullCatalog --------------------------------------------------------

test('buildFullCatalog: includes ALL tools including builder-floor (not filtered by creator)', () => {
  const full = buildFullCatalog();
  const creatorCatalog = buildCatalog('creator');
  // Full catalog is a strict superset of the creator-scoped catalog.
  assert.ok(full.length > creatorCatalog.length, 'full catalog must include builder+ tools not in creator catalog');
  assert.ok(full.some((t) => t.name === 'approve_promotion'), 'full catalog must include approve_promotion (builder-floor)');
});

test('buildFullCatalog: every entry carries name, tab, minRole, description, requires_approval', () => {
  const full = buildFullCatalog();
  assert.ok(full.length > 0, 'full catalog is non-empty');
  for (const entry of full) {
    assert.equal(typeof entry.name, 'string', `${entry.name}: name must be a string`);
    assert.ok(entry.name.length > 0, `${entry.name}: name must be non-empty`);
    assert.equal(typeof entry.tab, 'string', `${entry.name}: tab must be a string`);
    assert.equal(typeof entry.minRole, 'string', `${entry.name}: minRole must be a string`);
    assert.equal(typeof entry.description, 'string', `${entry.name}: description must be a string`);
    assert.equal(typeof entry.requires_approval, 'boolean', `${entry.name}: requires_approval must be a boolean`);
  }
});
