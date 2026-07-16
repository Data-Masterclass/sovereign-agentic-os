/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveContextUsage,
  deriveContextUsageByNode,
  deepLinkFor,
  type UsageNode,
} from './context-usage.ts';

test('captures a direct id-arg read with best-effort name from the result', () => {
  const nodes: UsageNode[] = [
    { steps: [{ tool: 'get_dataset', args: { datasetId: 'ds_orders' }, result: JSON.stringify({ name: 'Orders' }) }] },
  ];
  const u = deriveContextUsage(nodes);
  assert.deepEqual(u.items, [
    {
      kind: 'data',
      id: 'ds_orders',
      name: 'Orders',
      via: 'get_dataset',
      mode: 'read',
      confidence: 'captured',
      deepLink: '/data?focus=ds_orders',
    },
  ]);
  assert.deepEqual(u.byKind.data, ['ds_orders']);
});

test('tolerates args persisted as a JSON string (client fallback path)', () => {
  const nodes: UsageNode[] = [
    { steps: [{ tool: 'get_knowledge', args: JSON.stringify({ knowledgeId: 'ku_1' }), result: '{"title":"Policy"}' }] },
  ];
  const u = deriveContextUsage(nodes);
  assert.equal(u.items[0].id, 'ku_1');
  assert.equal(u.items[0].name, 'Policy');
  assert.equal(u.items[0].kind, 'knowledge');
  assert.equal(u.items[0].confidence, 'captured');
});

test('search_knowledge surfaces retrieved ids + titles from the result', () => {
  const nodes: UsageNode[] = [
    {
      steps: [
        {
          tool: 'search_knowledge',
          args: { query: 'pricing' },
          result: JSON.stringify({ hits: [{ id: 'ku_a', title: 'A' }, { id: 'ku_b', title: 'B' }] }),
        },
      ],
    },
  ];
  const u = deriveContextUsage(nodes);
  assert.deepEqual(u.items.map((i) => i.id), ['ku_a', 'ku_b']);
  assert.ok(u.items.every((i) => i.mode === 'retrieved' && i.confidence === 'captured'));
  assert.deepEqual(u.byKind.knowledge, ['ku_a', 'ku_b']);
});

test('query_data infers the physical FQN from SQL and marks it inferred', () => {
  const nodes: UsageNode[] = [
    { steps: [{ tool: 'query_data', args: { sql: 'select region, sum(revenue) from iceberg.sales.gold_orders group by region' }, result: '[]' }] },
  ];
  const u = deriveContextUsage(nodes);
  assert.deepEqual(u.items, [
    {
      kind: 'data',
      id: 'iceberg.sales.gold_orders',
      via: 'query_data',
      mode: 'read',
      confidence: 'inferred',
      // FQNs have no registry id → no deep link; the SQL is captured as the how-used hint.
      hint: 'select region, sum(revenue) from iceberg.sales.gold_orders group by region',
    },
  ]);
  assert.equal(u.items[0].deepLink, undefined);
});

test('query_data with no parseable FQN falls back to an opaque inferred touch', () => {
  const nodes: UsageNode[] = [{ steps: [{ tool: 'query_data', args: { sql: 'select 1' }, result: '[]' }] }];
  const u = deriveContextUsage(nodes);
  assert.equal(u.items[0].id, 'data:sql');
  assert.equal(u.items[0].confidence, 'inferred');
});

test('an errored read is surfaced but NOT counted in the roll-up', () => {
  const nodes: UsageNode[] = [
    { steps: [{ tool: 'get_dataset', args: { datasetId: 'ds_denied' }, result: '{"error":{"code":"not_found"}}', isError: true }] },
  ];
  const u = deriveContextUsage(nodes);
  assert.equal(u.items.length, 1);
  assert.equal(u.items[0].errored, true);
  assert.deepEqual(u.byKind.data, []); // errored context was never obtained
});

test('an errored search yields no retrieved ids', () => {
  const nodes: UsageNode[] = [
    { steps: [{ tool: 'search_files', args: { query: 'x' }, result: '{"error":{"code":"forbidden"}}', isError: true }] },
  ];
  const u = deriveContextUsage(nodes);
  assert.equal(u.items.length, 0);
  assert.deepEqual(u.byKind.files, []);
});

test('a write tool that ran records the target as written', () => {
  const nodes: UsageNode[] = [
    { steps: [{ tool: 'define_metric', args: { metricId: 'm_gm', name: 'Gross Margin' }, result: '{"id":"m_gm"}' }] },
  ];
  const u = deriveContextUsage(nodes);
  assert.equal(u.items[0].kind, 'metrics');
  assert.equal(u.items[0].mode, 'written');
  assert.equal(u.items[0].id, 'm_gm');
  assert.deepEqual(u.byKind.metrics, ['m_gm']);
});

test('rolls up across nodes, deduping repeated reads, and truncated results just under-count', () => {
  const nodes: UsageNode[] = [
    { steps: [{ tool: 'get_dataset', args: { datasetId: 'ds_1' }, result: '{"name":"One"}' }] },
    {
      steps: [
        { tool: 'get_dataset', args: { datasetId: 'ds_1' }, result: '{"name":"One"}' }, // dup
        { tool: 'use_connection', args: { connectionId: 'c_pg' }, result: 'not-json-truncated…' }, // no name, tolerated
      ],
    },
  ];
  const u = deriveContextUsage(nodes);
  assert.deepEqual(u.byKind.data, ['ds_1']);
  assert.deepEqual(u.byKind.connections, ['c_pg']);
  // The connection read had a non-JSON (truncated) result → no name, still counted.
  assert.equal(u.items.find((i) => i.id === 'c_pg')?.name, undefined);
});

test('empty / missing nodes are safe', () => {
  assert.deepEqual(deriveContextUsage([]).items, []);
  assert.deepEqual(deriveContextUsage([{}]).items, []);
});

// ── deep links ───────────────────────────────────────────────────────────────

test('deepLinkFor maps every resolvable kind to its real tab route + ?focus id', () => {
  assert.equal(deepLinkFor('data', 'ds_1'), '/data?focus=ds_1');
  assert.equal(deepLinkFor('knowledge', 'ku_1'), '/knowledge?focus=ku_1');
  assert.equal(deepLinkFor('files', 'as_1'), '/unstructured?focus=as_1');
  assert.equal(deepLinkFor('metrics', 'm_1'), '/metrics?focus=m_1');
  assert.equal(deepLinkFor('connections', 'c_1'), '/connections?focus=c_1');
});

test('deepLinkFor encodes the id and refuses unresolvable ids', () => {
  assert.equal(deepLinkFor('files', 'a b/c'), '/unstructured?focus=a%20b%2Fc');
  assert.equal(deepLinkFor('data', 'data:sql'), undefined); // opaque touch
  assert.equal(deepLinkFor('data', 'iceberg.sales.gold_orders'), undefined); // physical FQN
  assert.equal(deepLinkFor('data', ''), undefined);
});

test('a captured search hit carries a deep link to its item', () => {
  const nodes: UsageNode[] = [
    { steps: [{ tool: 'search_files', args: { query: 'contract' }, result: JSON.stringify({ hits: [{ id: 'as_9', title: 'Acme' }] }) }] },
  ];
  const u = deriveContextUsage(nodes);
  assert.equal(u.items[0].deepLink, '/unstructured?focus=as_9');
});

// ── how it was used (hint) ────────────────────────────────────────────────────

test('a search retrieval captures the query as its how-used hint', () => {
  const nodes: UsageNode[] = [
    { steps: [{ tool: 'search_knowledge', args: { query: 'refund policy' }, result: JSON.stringify({ hits: [{ id: 'ku_1' }] }) }] },
  ];
  const u = deriveContextUsage(nodes);
  assert.equal(u.items[0].hint, 'refund policy');
});

test('hints are clipped to a single short line (no raw blobs)', () => {
  const long = 'select '.repeat(60);
  const nodes: UsageNode[] = [{ steps: [{ tool: 'query_data', args: { sql: long }, result: '[]' }] }];
  const u = deriveContextUsage(nodes);
  assert.ok((u.items[0].hint ?? '').length <= 120);
  assert.ok((u.items[0].hint ?? '').endsWith('…'));
});

// ── per-agent attribution ─────────────────────────────────────────────────────

test('deriveContextUsageByNode attributes context to each agent separately', () => {
  const nodes: UsageNode[] = [
    { node: 'researcher', steps: [{ tool: 'get_dataset', args: { datasetId: 'ds_1' }, result: '{"name":"One"}' }] },
    { node: 'writer', steps: [{ tool: 'get_knowledge', args: { knowledgeId: 'ku_1' }, result: '{"title":"P"}' }] },
  ];
  const byNode = deriveContextUsageByNode(nodes);
  assert.equal(byNode.length, 2);
  assert.equal(byNode[0].node, 'researcher');
  assert.deepEqual(byNode[0].items.map((i) => i.id), ['ds_1']);
  assert.equal(byNode[1].node, 'writer');
  assert.deepEqual(byNode[1].items.map((i) => i.id), ['ku_1']);
});

test('deriveContextUsageByNode omits nodes that touched nothing and labels unnamed nodes', () => {
  const nodes: UsageNode[] = [
    { node: 'planner', steps: [{ tool: 'noop_tool', args: {} }] }, // touches nothing
    { steps: [{ tool: 'get_dataset', args: { datasetId: 'ds_2' }, result: '{}' }] }, // unnamed
  ];
  const byNode = deriveContextUsageByNode(nodes);
  assert.equal(byNode.length, 1);
  assert.equal(byNode[0].node, 'agent 2'); // positional fallback keeps its index
  assert.deepEqual(byNode[0].items.map((i) => i.id), ['ds_2']);
});

// ── ?focus deep-link round-trip (documents the URL each tab receives) ─────────

test('deepLinkFor produces ?focus=<id> routes for all five context tabs', () => {
  // The produced deep links are the URLs that land on each tab; the tab reads
  // `useSearchParams().get("focus")` and decodes it to open the item. This test
  // pins the format so any route change is immediately visible.
  assert.equal(deepLinkFor('data',        'ds_orders'),   '/data?focus=ds_orders');
  assert.equal(deepLinkFor('knowledge',   'ku_policy'),   '/knowledge?focus=ku_policy');
  assert.equal(deepLinkFor('files',       'as_contract'), '/unstructured?focus=as_contract');
  assert.equal(deepLinkFor('metrics',     'mt_revenue'),  '/metrics?focus=mt_revenue');
  assert.equal(deepLinkFor('connections', 'conn_pg'),     '/connections?focus=conn_pg');
});

test('deepLinkFor url-encodes special chars in the id', () => {
  // decodeURIComponent on the receiving end should recover the original id.
  const link = deepLinkFor('data', 'ds/with spaces&special');
  assert.ok(link !== undefined);
  const url = new URL(link!, 'http://x');
  assert.equal(url.searchParams.get('focus'), 'ds/with spaces&special');
});
