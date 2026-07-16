/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@/lib/core/auth';
import { handleRpc, ALL_MCP_TOOLS, type JsonRpcResponse, type ToolError } from './server.ts';
import { ALL_WRITE_TOOLS, __setRunOsTeamForTests } from './write-tools.ts';
import { __resetStore as resetData } from '@/lib/data/store';
import { __resetStore as resetAgents } from '@/lib/agents/store';
import { __resetApprovals } from '@/lib/governance/approvals';
import { _resetModels, upsertModel } from '@/lib/science';
import type { ServiceModel } from '@/lib/science/types';

/**
 * MCP WAVE A — the physical data pipeline (ingest→profile→silver→gold), the
 * semantic-layer read (query_metric), the agents run door (run_agent_system) and
 * the Science read surface (list_models/get_model + my/science). Every tool is a
 * THIN wrapper over the same governed lib the UI calls, driven here exactly as an
 * AI client would (over handleRpc), asserting:
 *   • identity is threaded = the CALLER (never a body value),
 *   • governance negatives are TYPED errors (forbidden/not_found/bad_request),
 *   • honesty: offline paths are labelled, nothing is registered on a ✗.
 */

const creator: CurrentUser = { id: 'cara', name: 'Cara', domains: ['sales'], role: 'creator' };
// Ben is a domain_admin: rung-1 Personal→Shared approval (approve_promotion) now needs domain_admin+.
const builder: CurrentUser = { id: 'ben', name: 'Ben', domains: ['sales'], role: 'domain_admin' };
const outsider: CurrentUser = { id: 'dan', name: 'Dan', domains: ['ops'], role: 'creator' };

function resetAll(): void {
  resetData();
  resetAgents();
  __resetApprovals();
  _resetModels();
}

async function call(user: CurrentUser, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const res = await handleRpc(user, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  assert.ok(res && 'result' in res, `expected a result for ${name}`);
  return (res as JsonRpcResponse).result as Record<string, unknown>;
}

function payload<T = Record<string, unknown>>(r: Record<string, unknown>): T {
  assert.notEqual(r.isError, true, `expected success, got: ${(r.content as { text: string }[])[0]?.text}`);
  return JSON.parse((r.content as { text: string }[])[0].text) as T;
}

function errorOf(r: Record<string, unknown>): ToolError {
  assert.equal(r.isError, true, 'expected a typed tool error');
  return (r.structuredContent as { error: ToolError }).error;
}

// ---- REGISTRY INVARIANTS ------------------------------------------------------

const NEW_WRITE = ['ingest_dataset', 'transform_silver', 'build_gold_join', 'run_agent_system'];
const NEW_READ = ['profile_dataset', 'query_metric', 'list_models', 'get_model'];

test('WAVE A registry: every new tool is registered, exampled, and R/W-classified correctly', async () => {
  const byName = new Map(ALL_MCP_TOOLS.map((t) => [t.name, t]));
  const writeNames = new Set(ALL_WRITE_TOOLS.map((t) => t.name));
  for (const n of [...NEW_WRITE, ...NEW_READ]) {
    const t = byName.get(n);
    assert.ok(t, `${n} missing from ALL_MCP_TOOLS`);
    assert.equal(t!.minRole, 'creator', `${n} floors at creator`);
    assert.ok((t!.inputSchema.examples ?? []).length >= 1, `${n} carries ≥1 worked example`);
    assert.ok(t!.description.length > 200, `${n} carries a rich description`);
  }
  for (const n of NEW_WRITE) assert.ok(writeNames.has(n), `${n} must be in ALL_WRITE_TOOLS`);
  for (const n of NEW_READ) assert.ok(!writeNames.has(n), `${n} is read-only, not a write tool`);

  // All visible to a creator via list_capabilities.
  const caps = payload<{ available: { name: string }[] }>(await call(creator, 'list_capabilities'));
  const avail = new Set(caps.available.map((t) => t.name));
  for (const n of [...NEW_WRITE, ...NEW_READ]) assert.ok(avail.has(n), `${n} available to a creator`);
});

test('WAVE A: query_metric accepts NO SQL by construction (semantic layer only)', () => {
  const t = ALL_MCP_TOOLS.find((x) => x.name === 'query_metric')!;
  assert.ok(!('sql' in t.inputSchema.properties), 'query_metric has no sql parameter — a raw statement is impossible by construction');
  assert.deepEqual(Object.keys(t.inputSchema.properties).sort(), ['dimensions', 'granularity', 'limit', 'metricId', 'timeDimension']);
});

// ---- INGEST → PROFILE → SILVER → GOLD (the physical pipeline, offline-honest) --

test('ingest_dataset: ingests inline CSV as the caller and registers Bronze only on ✓ (offline-mock labelled)', async () => {
  resetAll();
  const ds = payload(await call(builder, 'create_dataset', { name: 'Orders' }));
  const r = payload<{ ok: boolean; mode: string; bronzeRegistered: boolean; table: string }>(
    await call(builder, 'ingest_dataset', { datasetId: ds.id, fileName: 'orders.csv', content: 'order_id,net_amount\n1001,250.00\n1002,90.50' }),
  );
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'offline-mock', 'no cluster in tests — the mode is honestly labelled');
  assert.equal(r.bronzeRegistered, true);
  assert.match(r.table, /^iceberg\.personal_ben\.bronze_/, 'the physical target is the CALLER’s personal schema');

  const after = payload<{ versions: { bronze: { built: boolean } } }>(await call(builder, 'get_dataset', { datasetId: ds.id }));
  assert.equal(after.versions.bronze.built, true, 'Bronze dot lit only after a verified landing');
});

test('get_dataset surfaces the REAL physical FQN for a granted, built dataset (anti-#97 consumability)', async () => {
  // The agent must NOT guess table names: once a layer is built, get_dataset's
  // `queryable` names the exact iceberg.<schema>.<table> to hand to query_data.
  resetAll();
  const ds = payload(await call(builder, 'create_dataset', { name: 'Orders' }));
  payload(await call(builder, 'ingest_dataset', { datasetId: ds.id, fileName: 'o.csv', content: 'order_id,net_amount\n1,10' }));

  const view = payload<{ queryable: { available: boolean; layer: string; fqn: string } }>(
    await call(builder, 'get_dataset', { datasetId: ds.id, layer: 'bronze' }),
  );
  assert.equal(view.queryable.available, true, 'a built layer resolves to a queryable FQN');
  assert.equal(view.queryable.layer, 'bronze');
  assert.match(view.queryable.fqn, /^iceberg\.personal_ben\.bronze_/, 'the real FQN, in the CALLER’s viewer-aware schema');
});

test('ingest_dataset: oversized in-band content → typed bad_request pointing to the UI upload', async () => {
  resetAll();
  const ds = payload(await call(builder, 'create_dataset', { name: 'Big' }));
  const big = 'x'.repeat(2 * 1024 * 1024 + 1024);
  const e = errorOf(await call(builder, 'ingest_dataset', { datasetId: ds.id, content: `a\n${big}` }));
  assert.equal(e.code, 'bad_request');
  assert.match(e.reason, /2 MB/, 'the cap is stated');
  assert.match(e.reason, /UI/, 'the hint points to the UI upload path');
});

test('ingest_dataset: a dataset the caller cannot see → typed forbidden (identity from the session, never the body)', async () => {
  resetAll();
  const ds = payload(await call(creator, 'create_dataset', { name: 'Cara private' }));
  const e = errorOf(await call(outsider, 'ingest_dataset', { datasetId: ds.id, content: 'a\n1' }));
  assert.equal(e.code, 'forbidden');
});

test('profile_dataset: honest {available:false} offline; typed forbidden for a non-viewer; nothing-built stated plainly', async () => {
  resetAll();
  const ds = payload(await call(builder, 'create_dataset', { name: 'Orders' }));

  // Nothing built yet → a calm, honest reason (never a fake profile).
  const empty = payload<{ available: boolean; reason: string }>(await call(builder, 'profile_dataset', { datasetId: ds.id }));
  assert.equal(empty.available, false);
  assert.match(empty.reason, /Bronze/);

  // Bronze registered but the physical table is not queryable in tests (query-tool
  // offline) → available:false with the real reason, not a crash.
  payload(await call(builder, 'add_dataset_version', { datasetId: ds.id, layer: 'bronze' }));
  const offline = payload<{ available: boolean; layer: string; reason: string }>(await call(builder, 'profile_dataset', { datasetId: ds.id }));
  assert.equal(offline.available, false);
  assert.equal(offline.layer, 'bronze');
  assert.ok(offline.reason.length > 0);

  // A non-viewer gets a typed forbidden (no existence leak beyond the named id).
  const e = errorOf(await call(outsider, 'profile_dataset', { datasetId: ds.id }));
  assert.equal(e.code, 'forbidden');
});

test('transform_silver: compiles guided ops server-side, builds as the caller, registers Silver only on ✓', async () => {
  resetAll();
  const ds = payload(await call(builder, 'create_dataset', { name: 'Orders' }));

  // Without Bronze → typed bad_request naming the missing step.
  const noBronze = errorOf(await call(builder, 'transform_silver', { datasetId: ds.id, columns: ['a'] }));
  assert.equal(noBronze.code, 'bad_request');
  assert.match(noBronze.reason, /Bronze/);

  payload(await call(builder, 'add_dataset_version', { datasetId: ds.id, layer: 'bronze' }));
  const r = payload<{ ok: boolean; mode: string; sql: string; target: string; dots: { silver: boolean } }>(
    await call(builder, 'transform_silver', {
      datasetId: ds.id,
      columns: ['order_id', 'net_amount'],
      ops: [
        { kind: 'cast', column: 'net_amount', type: 'double' },
        { kind: 'filter', column: 'order_id', op: 'not_null' },
        { kind: 'dedupe', keys: ['order_id'] },
      ],
    }),
  );
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'offline-mock', 'honest mode label');
  assert.match(r.sql, /^create or replace table iceberg\.personal_ben\.silver_orders as /, 'the CTAS targets the CALLER’s own schema');
  assert.match(r.sql, /cast\("net_amount" as double\)/);
  assert.ok(!r.sql.includes(';') && !r.sql.includes('--'), 'guard-shaped: one statement, no comments');
  assert.equal(r.dots.silver, true, 'Silver registered on ✓');

  // A bad op set is a typed bad_request with the compiler’s real reason.
  const bad = errorOf(await call(builder, 'transform_silver', { datasetId: ds.id, columns: ['order_id'], ops: [{ kind: 'drop', column: 'order_id' }] }));
  assert.equal(bad.code, 'bad_request');
  assert.match(bad.reason, /dropped/);
});

test('build_gold_join: joins only canView datasets (ids re-resolved server-side), records Gold + measures + lineage on ✓', async () => {
  resetAll();
  // A joinable governed asset: Ben builds + documents + promotes "Customers".
  const cust = payload(await call(builder, 'create_dataset', { name: 'Customers' }));
  payload(await call(builder, 'add_dataset_version', { datasetId: cust.id, layer: 'bronze' }));
  payload(await call(builder, 'add_dataset_version', { datasetId: cust.id, layer: 'silver', body: 'select customer_id, region from bronze' }));
  payload(await call(builder, 'document_dataset', { datasetId: cust.id, description: 'One row per customer.', columns: [{ name: 'customer_id', description: 'PK' }] }));
  const req = payload<{ approvalId: string }>(await call(builder, 'request_promotion', { kind: 'dataset', id: cust.id }));
  payload(await call(builder, 'approve_promotion', { approvalId: req.approvalId }));

  // The base: Bronze + Silver built.
  const ds = payload(await call(builder, 'create_dataset', { name: 'Orders' }));
  payload(await call(builder, 'add_dataset_version', { datasetId: ds.id, layer: 'bronze' }));
  payload(await call(builder, 'add_dataset_version', { datasetId: ds.id, layer: 'silver', body: 'select order_id, customer_id, net_amount from bronze' }));

  const r = payload<{ ok: boolean; mode: string; sql: string; goldRegistered: boolean; measures: { name: string }[]; upstreams: { datasetId: string }[] }>(
    await call(builder, 'build_gold_join', {
      datasetId: ds.id,
      picks: [{ datasetId: cust.id, type: 'left', on: [{ left: { ref: 0, column: 'customer_id' }, right: 'customer_id' }] }],
      dimensions: [{ col: { ref: 1, column: 'region' } }],
      measures: [{ name: 'revenue', agg: 'sum', col: { ref: 0, column: 'net_amount' } }],
    }),
  );
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'offline-mock');
  assert.match(r.sql, /left join iceberg\./, 'the pick was resolved to its physical FQN server-side');
  assert.match(r.sql, /group by/, 'measures + dimensions ⇒ grouped');
  assert.equal(r.goldRegistered, true);
  assert.equal(r.measures[0].name, 'revenue', 'measures recorded for the Cube scaffold');
  assert.equal(r.upstreams[0].datasetId, cust.id, 'multi-upstream lineage recorded');

  // A pick the caller cannot READ → typed forbidden (canView re-check per pick).
  const secret = payload(await call(creator, 'create_dataset', { name: 'Cara secret' }));
  const e = errorOf(await call(builder, 'build_gold_join', {
    datasetId: ds.id,
    picks: [{ datasetId: secret.id, on: [{ left: { ref: 0, column: 'order_id' }, right: 'x' }] }],
    measures: [{ name: 'n', agg: 'count' }],
  }));
  assert.equal(e.code, 'forbidden');
});

// ---- QUERY_METRIC (the semantic-layer read) ------------------------------------

/** Build a governed gold dataset with a defined metric; returns its metricId. */
async function definedMetric(): Promise<string> {
  const ds = payload(await call(builder, 'create_dataset', { name: 'Orders', columns: [{ name: 'net_amount', description: 'EUR' }] }));
  payload(await call(builder, 'add_dataset_version', { datasetId: ds.id, layer: 'bronze' }));
  payload(await call(builder, 'add_dataset_version', { datasetId: ds.id, layer: 'silver', body: 'select order_id, net_amount from bronze' }));
  payload(await call(builder, 'add_dataset_version', { datasetId: ds.id, layer: 'gold', passThrough: true }));
  payload(await call(builder, 'document_dataset', { datasetId: ds.id, description: 'One row per order.' }));
  const req = payload<{ approvalId: string }>(await call(builder, 'request_promotion', { kind: 'dataset', id: ds.id }));
  payload(await call(builder, 'approve_promotion', { approvalId: req.approvalId }));
  payload(await call(builder, 'define_metric', { datasetId: ds.id, name: 'Revenue', aggregation: 'sum', column: 'net_amount' }));
  return `${ds.id}.revenue`;
}

test('query_metric: resolves the governed Cube member under the CALLER’s delegated identity (offline-mock honest)', async () => {
  resetAll();
  const metricId = await definedMetric();
  const r = payload<{ member: string; value: number | null; rows: unknown[]; mode: string; securityContext: Record<string, unknown> }>(
    await call(builder, 'query_metric', { metricId }),
  );
  assert.match(r.member, /\.revenue$/, 'the canonical member — the one definition of the number');
  assert.equal(typeof r.value, 'number', 'a scalar came back');
  assert.equal(r.mode, 'offline-mock', 'no live Cube in tests — labelled honestly');
  assert.ok(r.rows.length > 0);
  assert.ok(r.securityContext, 'the per-viewer securityContext is stated (R3)');
});

test('query_metric: a metric on a dataset the caller cannot see → typed forbidden; garbage id → typed not_found', async () => {
  resetAll();
  const metricId = await definedMetric(); // owned by ben, tier asset in `sales`
  const e = errorOf(await call(outsider, 'query_metric', { metricId })); // dan is in `ops`
  assert.equal(e.code, 'forbidden');
  const missing = errorOf(await call(builder, 'query_metric', { metricId: 'ds_nope.revenue' }));
  assert.equal(missing.code, 'not_found');
});

// ---- RUN_AGENT_SYSTEM ----------------------------------------------------------

test('run_agent_system: runs the team AS THE CALLER (identity threaded to runOsTeam) and returns per-node steps', async () => {
  resetAll();
  const sys = payload<{ id: string }>(await call(builder, 'create_agent_system', { name: 'Support triage', template: 'analyze' }));

  let seen: { userId?: string; systemId?: string; messages?: unknown[] } = {};
  __setRunOsTeamForTests(async (input) => {
    seen = { userId: input.user.id, systemId: input.systemId, messages: input.messages };
    return {
      path: ['analyst'],
      finalText: 'Tickets triaged.',
      runs: [{ node: 'analyst', model: 'exec-model', result: { steps: [{ tool: 'search_knowledge', isError: false }] } }],
    };
  });
  try {
    const r = payload<{ finalText: string; path: string[]; nodes: { node: string; steps: { tool: string }[] }[] }>(
      await call(builder, 'run_agent_system', { systemId: sys.id, message: 'Triage the queue' }),
    );
    assert.equal(seen.userId, 'ben', 'runOsTeam received the CALLER identity — never a service principal');
    assert.equal(seen.systemId, sys.id);
    assert.deepEqual(seen.messages, [{ role: 'user', content: 'Triage the queue' }]);
    assert.equal(r.finalText, 'Tickets triaged.');
    assert.equal(r.nodes[0].steps[0].tool, 'search_knowledge');
  } finally {
    __setRunOsTeamForTests(null);
  }
});

test('run_agent_system: a system the caller cannot run → typed forbidden; a hermes system → typed bad_request to the UI', async () => {
  resetAll();
  // Cara's Personal system: Dan (out of domain) AND Ben (in-domain, but Personal ≠ Shared) may not run it.
  const sys = payload<{ id: string }>(await call(creator, 'create_agent_system', { name: 'Cara private', template: 'analyze' }));
  const e = errorOf(await call(outsider, 'run_agent_system', { systemId: sys.id, message: 'hi' }));
  assert.equal(e.code, 'forbidden');

  // A hermes-runtime system is honestly refused with a pointer to the UI path.
  const own = payload<{ id: string }>(await call(builder, 'create_agent_system', { name: 'Autono', template: 'blank' }));
  const view = payload<{ yaml: string }>(await call(builder, 'get_agent_system', { systemId: own.id }));
  payload(await call(builder, 'commit_agent_files', { systemId: own.id, path: 'system.yaml', content: `${view.yaml}\nruntime: hermes\n` }));
  const hermes = errorOf(await call(builder, 'run_agent_system', { systemId: own.id, message: 'hi' }));
  assert.equal(hermes.code, 'bad_request');
  assert.match(hermes.reason, /Agents tab UI/);
});

// ---- SCIENCE READ SURFACE ------------------------------------------------------

const CHURN_MODEL: ServiceModel = {
  id: 'm_churn',
  model: 'churn_model',
  name: 'Churn risk',
  owner: 'ben',
  domain: 'sales',
  tier: 'Domain',
  stage: 'Production',
  frontDoors: ['rest', 'mcp'],
  versions: [{ version: '2', stage: 'Production', auc: 0.91, certified: true, runId: 'run_1' }],
};

test('list_models: RLS-scoped + honest about ml.enabled; another user’s Personal model never appears', async () => {
  resetAll();
  // Empty tenant: an empty list + the honest serving note (ml disabled in tests).
  const empty = payload<{ mlEnabled: boolean; note?: string; models: unknown[] }>(await call(creator, 'list_models'));
  assert.equal(empty.mlEnabled, false);
  assert.match(empty.note ?? '', /ml\.enabled/, 'says plainly that predict will 404');
  assert.deepEqual(empty.models, []);

  upsertModel(CHURN_MODEL);
  upsertModel({ ...CHURN_MODEL, id: 'm_p', model: 'ops_personal', name: 'Ops private', owner: 'dan', domain: 'ops', tier: 'Personal' });

  const cara = payload<{ models: { model: string }[] }>(await call(creator, 'list_models'));
  assert.deepEqual(cara.models.map((m) => m.model), ['churn_model'], 'sales creator sees the sales Domain model, NOT dan’s Personal one');
});

test('get_model: the full card (features, bands, metrics, serving); out-of-scope → not_found (no existence leak)', async () => {
  resetAll();
  upsertModel(CHURN_MODEL);
  const card = payload<{ model: string; features: string[]; scoreBands: Record<string, string>; metrics: { auc: number }; tier: string; frontDoors: string[] }>(
    await call(creator, 'get_model', { model: 'churn_model' }),
  );
  assert.equal(card.model, 'churn_model');
  assert.deepEqual(card.features, ['recency_days', 'order_frequency', 'monetary_value', 'tenure_months']);
  assert.equal(card.metrics.auc, 0.91);
  assert.ok(card.scoreBands.high, 'the churn score bands are stated');
  assert.deepEqual(card.frontDoors, ['rest', 'mcp']);

  const e = errorOf(await call(outsider, 'get_model', { model: 'churn_model' })); // dan is in ops — Domain scope excludes him
  assert.equal(e.code, 'not_found', 'unseeable == unknown, mirroring the predict gate');
});

test('my/science resource: the caller’s scoreable-model inventory, matching the other my/* resources', async () => {
  resetAll();
  upsertModel(CHURN_MODEL);
  const res = await handleRpc(creator, { jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'sovereign-os://my/science' } });
  assert.ok(res && 'result' in res);
  const contents = ((res as JsonRpcResponse).result as { contents: { mimeType: string; text: string }[] }).contents;
  assert.equal(contents[0].mimeType, 'application/json');
  const inv = JSON.parse(contents[0].text) as { mlEnabled: boolean; models: { model: string }[] };
  assert.equal(inv.mlEnabled, false);
  assert.deepEqual(inv.models.map((m) => m.model), ['churn_model']);
});
