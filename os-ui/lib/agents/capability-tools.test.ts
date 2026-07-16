/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toolsForGrant,
  allToolsForKind,
  capabilityWrites,
  presetForCapability,
  strongestPreset,
  capabilityChipsForGrants,
  toolsForCapabilityChips,
  chipIdsForTools,
  CAPABILITY_CHIPS,
} from './capability-tools.ts';
import type { Grants } from './system-schema.ts';

test('Read grants provision only read + discovery tools', () => {
  assert.deepEqual(toolsForGrant('data', 'Read'), ['query_data', 'list_datasets', 'get_dataset', 'profile_dataset']);
  assert.deepEqual(toolsForGrant('files', 'Read'), ['list_files', 'search_files', 'get_file']);
  // no write tool leaks into a Read grant
  assert.ok(!toolsForGrant('knowledge', 'Read').includes('author_knowledge'));
});

test('Write grants add the create/write tools on top of read', () => {
  for (const cap of ['Write-approval', 'Write-bounded'] as const) {
    const data = toolsForGrant('data', cap);
    assert.ok(data.includes('query_data') && data.includes('create_dataset') && data.includes('ingest_dataset'));
    assert.ok(toolsForGrant('knowledge', cap).includes('author_knowledge'));
    assert.ok(toolsForGrant('files', cap).includes('upload_file'));
    assert.ok(toolsForGrant('connections', cap).includes('create_connection'));
  }
});

test('Off / Blocked provision nothing', () => {
  assert.deepEqual(toolsForGrant('data', 'Off'), []);
  assert.deepEqual(toolsForGrant('files', 'Blocked'), []);
});

test('promotion / lifecycle tools are never auto-provisioned', () => {
  const all = (['data', 'knowledge', 'connections'] as const).flatMap((k) => toolsForGrant(k, 'Write-bounded'));
  for (const forbidden of ['request_promotion', 'approve_promotion', 'publish_knowledge', 'retire_knowledge', 'promote_connection']) {
    assert.ok(!all.includes(forbidden), `${forbidden} must not be auto-granted`);
  }
});

test('capabilityWrites: only the two write levels', () => {
  assert.equal(capabilityWrites('Read'), false);
  assert.equal(capabilityWrites('Write-approval'), true);
  assert.equal(capabilityWrites('Write-bounded'), true);
  assert.equal(capabilityWrites('Off'), false);
});

test('presetForCapability maps to the run-time posture', () => {
  assert.equal(presetForCapability('Read'), 'read-only');
  assert.equal(presetForCapability('Write-approval'), 'read-propose');
  assert.equal(presetForCapability('Write-bounded'), 'full-in-scope');
});

test('strongestPreset picks the most permissive; empty ⇒ read-only', () => {
  assert.equal(strongestPreset([]), 'read-only');
  assert.equal(strongestPreset(['read-only', 'read-propose']), 'read-propose');
  assert.equal(strongestPreset(['read-propose', 'full-in-scope', 'read-only']), 'full-in-scope');
});

test('allToolsForKind covers read ∪ write for pruning', () => {
  const data = allToolsForKind('data');
  assert.ok(data.includes('query_data') && data.includes('create_dataset'));
  assert.equal(new Set(data).size, data.length); // deduped
});

// ─── Capability chips ─────────────────────────────────────────────────────────

type ChipGrants = Pick<Grants, 'data' | 'knowledge' | 'connections' | 'metrics' | 'plan'>;

/** A grants object where every resource list is populated. */
const FULL_GRANTS: ChipGrants = {
  data: [{ id: 'ds_sales', capability: 'Read' }],
  knowledge: [{ id: 'wf_playbook', capability: 'Read' }],
  connections: [{ id: 'conn_crm', capability: 'Read' }],
  metrics: [{ id: 'mt_revenue', capability: 'Read' }],
  plan: [{ id: 'manual:domain', capability: 'Read' }],
};

/** Grants where only data was granted. */
const DATA_ONLY_GRANTS: ChipGrants = {
  data: [{ id: 'ds_sales', capability: 'Read' }],
  knowledge: [],
  connections: [],
  metrics: [],
  plan: [],
};

/** Grants where nothing was granted. */
const EMPTY_GRANTS: ChipGrants = {
  data: [],
  knowledge: [],
  connections: [],
  metrics: [],
  plan: [],
};

test('capabilityChipsForGrants: ungranted kind is not offered', () => {
  const chips = capabilityChipsForGrants(DATA_ONLY_GRANTS, null);
  const ids = chips.map((c) => c.id);
  // data was granted → offered
  assert.ok(ids.includes('read-data'), 'read-data should be offered when data is granted');
  // knowledge/connections/metrics were NOT granted → their chips absent
  assert.ok(!ids.includes('search-knowledge'), 'search-knowledge must not appear when knowledge not granted');
  assert.ok(!ids.includes('use-connection'), 'use-connection must not appear when connections not granted');
  assert.ok(!ids.includes('query-metrics'), 'query-metrics must not appear when metrics not granted');
  // null-grantKind chips (create-files, use-goals) are always offered
  assert.ok(ids.includes('create-files'), 'create-files always offered (no resource gate)');
  assert.ok(ids.includes('use-goals'), 'use-goals always offered (no resource gate)');
});

test('capabilityChipsForGrants: no grants → only null-grantKind chips offered', () => {
  const chips = capabilityChipsForGrants(EMPTY_GRANTS, null);
  const ids = chips.map((c) => c.id);
  assert.ok(!ids.includes('read-data'));
  assert.ok(!ids.includes('search-knowledge'));
  assert.ok(!ids.includes('use-connection'));
  assert.ok(!ids.includes('query-metrics'));
  assert.ok(!ids.includes('read-operating-manual')); // plan-gated
  // null-grantKind chips still present
  assert.ok(ids.includes('create-files'));
  assert.ok(ids.includes('use-goals'));
});

test('capabilityChipsForGrants: a plan (Operating Manual) grant offers the manual chip', () => {
  const ids = capabilityChipsForGrants(FULL_GRANTS, null).map((c) => c.id);
  assert.ok(ids.includes('read-operating-manual'));
});

test('capabilityChipsForGrants: full grants → all chips offered (catalog null = no catalog filter)', () => {
  const chips = capabilityChipsForGrants(FULL_GRANTS, null);
  assert.equal(chips.length, CAPABILITY_CHIPS.length, 'all chips present when fully granted + no catalog filter');
});

test('capabilityChipsForGrants: catalog filtering removes chips whose tools are absent', () => {
  // A catalog that only has query_data and its siblings (data read tools).
  const catalogWithDataOnly = ['query_data', 'list_datasets', 'get_dataset', 'profile_dataset'];
  const chips = capabilityChipsForGrants(FULL_GRANTS, catalogWithDataOnly);
  const ids = chips.map((c) => c.id);
  assert.ok(ids.includes('read-data'), 'data tools in catalog → read-data offered');
  // search-knowledge requires search_knowledge etc. which is not in this catalog
  assert.ok(!ids.includes('search-knowledge'), 'search-knowledge missing from catalog → chip hidden');
  assert.ok(!ids.includes('use-connection'), 'connection tools missing → hidden');
  assert.ok(!ids.includes('query-metrics'), 'metric tools missing → hidden');
  assert.ok(!ids.includes('create-files'), 'file tools missing → hidden');
  assert.ok(!ids.includes('use-goals'), 'goals tools missing → hidden');
});

test('Auto default: agent.tools === undefined means Auto (no chip implies no tools set)', () => {
  // The contract: when no chips are selected and the user reverts, we pass tools=undefined.
  // toolsForCapabilityChips([]) returns [] → callers revert to Auto.
  assert.deepEqual(toolsForCapabilityChips([]), []);
});

test('toolsForCapabilityChips returns union of selected chip tools', () => {
  const tools = toolsForCapabilityChips(['read-data', 'search-knowledge']);
  assert.ok(tools.includes('query_data'));
  assert.ok(tools.includes('search_knowledge'));
  // deduped
  assert.equal(tools.length, new Set(tools).size);
});

test('chipIdsForTools round-trips a selection of chips', () => {
  const original = ['read-data', 'search-knowledge'];
  const tools = toolsForCapabilityChips(original);
  const recovered = chipIdsForTools(tools);
  assert.ok(original.every((id) => recovered.includes(id)), 'round-trip preserves selected chips');
});

test('every capability chip carries a non-empty domain + description (picker groups by domain)', () => {
  for (const c of CAPABILITY_CHIPS) {
    assert.ok(c.domain && c.domain.length > 0, `${c.id} has a domain`);
    assert.ok(c.description && c.description.length > 0, `${c.id} has a description`);
  }
  // The picker groups per domain — data reads live under "Data", knowledge under "Knowledge".
  const byId = new Map(CAPABILITY_CHIPS.map((c) => [c.id, c]));
  assert.equal(byId.get('read-data')!.domain, 'Data');
  assert.equal(byId.get('search-knowledge')!.domain, 'Knowledge');
  assert.equal(byId.get('create-files')!.domain, 'Files');
});

test('chipIdsForTools: partial tool match does NOT recover the chip', () => {
  // Only one of the data tools — should not recover the chip since not all are present.
  const recovered = chipIdsForTools(['query_data']);
  assert.ok(!recovered.includes('read-data'), 'partial match does not count as the chip');
});
