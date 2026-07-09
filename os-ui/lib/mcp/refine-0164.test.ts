/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@/lib/core/auth';
import { handleRpc, ALL_MCP_TOOLS, type JsonRpcResponse, type ToolError } from './server.ts';
import { __resetStore as resetData } from '@/lib/data/store';
import { __resetStore as resetAgents } from '@/lib/agents/store';
import { __resetApprovals } from '@/lib/approvals';

/**
 * MCP 0.1.64 PARITY — the new refinement/metric capabilities the UI gained, now
 * reachable through the SAME governed MCP dispatch:
 *   • build_gold_join key mapping / reconcile (KeyAdapt: text-normalize + cast)
 *     — the schema exposes `adapt`, the handler forwards it, and it compiles into
 *     the governed CTAS (both sides wrapped symmetrically).
 *   • define_metric's rich Cube measure model — count_distinct_approx, filtered
 *     measure, rolling window, running total, ratio (derived number), format,
 *     drill members — all surfaced as guided params that compile to one Measure.
 * Driven exactly as an AI client would (over handleRpc), so the checks prove the
 * MCP capability == the UI capability (no drift), still fully governed.
 */

const creator: CurrentUser = { id: 'cara', name: 'Cara', domains: ['sales'], role: 'creator' };
const builder: CurrentUser = { id: 'ben', name: 'Ben', domains: ['sales'], role: 'builder' };

function resetAll(): void {
  resetData();
  resetAgents();
  __resetApprovals();
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

/** A governed, joinable "Customers" asset owned by Ben (promoted to shared). */
async function seedCustomers(): Promise<string> {
  const cust = payload<{ id: string }>(await call(builder, 'create_dataset', { name: 'Customers' }));
  payload(await call(builder, 'add_dataset_version', { datasetId: cust.id, layer: 'bronze' }));
  payload(await call(builder, 'add_dataset_version', { datasetId: cust.id, layer: 'silver', body: 'select customer_id, region from bronze' }));
  payload(await call(builder, 'document_dataset', { datasetId: cust.id, description: 'One row per customer.', columns: [{ name: 'customer_id', description: 'PK' }] }));
  const req = payload<{ approvalId: string }>(await call(builder, 'request_promotion', { kind: 'dataset', id: cust.id }));
  payload(await call(builder, 'approve_promotion', { approvalId: req.approvalId }));
  return cust.id;
}

/** Ben's own Orders base with Bronze + Silver built (ready to join into Gold). */
async function seedOrdersBase(): Promise<string> {
  const ds = payload<{ id: string }>(await call(builder, 'create_dataset', { name: 'Orders' }));
  payload(await call(builder, 'add_dataset_version', { datasetId: ds.id, layer: 'bronze' }));
  payload(await call(builder, 'add_dataset_version', { datasetId: ds.id, layer: 'silver', body: 'select order_id, cust_code, net_amount from bronze' }));
  return ds.id;
}

// ============================ build_gold_join: adapt ============================

test('build_gold_join schema exposes the `adapt` key-mapping option (text + cast) with a worked example', () => {
  const tool = ALL_MCP_TOOLS.find((t) => t.name === 'build_gold_join');
  assert.ok(tool, 'build_gold_join is registered');
  const on = (tool!.inputSchema.properties!.picks as Record<string, any>).items.properties.on.items;
  assert.ok(on.properties.adapt, 'the join-key item exposes an `adapt` property');
  assert.deepEqual(on.properties.adapt.properties.mode.enum, ['text', 'cast'], 'adapt.mode is text|cast');
  assert.ok(Array.isArray(on.properties.adapt.properties.type.enum), 'adapt.type offers the Trino cast types');
  assert.match(tool!.description, /key mapping|reconcile|adapt/i, 'description documents key reconciliation');
  const hasAdaptExample = (tool!.inputSchema.examples ?? []).some((ex) =>
    JSON.stringify(ex).includes('"adapt"'),
  );
  assert.ok(hasAdaptExample, 'carries a worked example that uses adapt');
});

test('build_gold_join: adapt {mode:"text"} compiles a symmetric lower(trim(cast … as varchar)) on BOTH key sides', async () => {
  resetAll();
  const custId = await seedCustomers();
  const dsId = await seedOrdersBase();

  const r = payload<{ ok: boolean; sql: string; goldRegistered: boolean }>(
    await call(builder, 'build_gold_join', {
      datasetId: dsId,
      picks: [
        {
          datasetId: custId,
          type: 'left',
          on: [{ left: { ref: 0, column: 'cust_code' }, right: 'customer_id', adapt: { mode: 'text' } }],
        },
      ],
      dimensions: [{ col: { ref: 1, column: 'region' } }],
      measures: [{ name: 'revenue', agg: 'sum', col: { ref: 0, column: 'net_amount' } }],
    }),
  );
  assert.equal(r.ok, true);
  assert.equal(r.goldRegistered, true);
  // Both sides of the equality are text-normalized (symmetric), never one-sided.
  assert.match(r.sql, /lower\(trim\(cast\(t0\."cust_code" as varchar\)\)\) = lower\(trim\(cast\(t1\."customer_id" as varchar\)\)\)/);
  assert.ok(!r.sql.includes(';') && !r.sql.includes('--'), 'guard-shaped: one statement, no comments');
});

test('build_gold_join: adapt {mode:"cast"} coerces both key sides to one Trino type', async () => {
  resetAll();
  const custId = await seedCustomers();
  const dsId = await seedOrdersBase();

  const r = payload<{ ok: boolean; sql: string }>(
    await call(builder, 'build_gold_join', {
      datasetId: dsId,
      picks: [
        {
          datasetId: custId,
          type: 'inner',
          on: [{ left: { ref: 0, column: 'cust_code' }, right: 'customer_id', adapt: { mode: 'cast', type: 'bigint' } }],
        },
      ],
      measures: [{ name: 'n', agg: 'count' }],
    }),
  );
  assert.match(r.sql, /cast\(t0\."cust_code" as bigint\) = cast\(t1\."customer_id" as bigint\)/);
});

test('build_gold_join: an invalid adapt cast type is a typed bad_request (server-side compile guard)', async () => {
  resetAll();
  const custId = await seedCustomers();
  const dsId = await seedOrdersBase();

  const e = errorOf(
    await call(builder, 'build_gold_join', {
      datasetId: dsId,
      picks: [
        {
          datasetId: custId,
          on: [{ left: { ref: 0, column: 'cust_code' }, right: 'customer_id', adapt: { mode: 'cast', type: 'nope' } }],
        },
      ],
      measures: [{ name: 'n', agg: 'count' }],
    }),
  );
  assert.equal(e.code, 'bad_request');
  assert.match(e.reason, /cast type/i);
});

// =========================== define_metric: rich model =========================

/** A governed, promoted Gold Orders dataset for define_metric (returns its id). */
async function goldOrders(): Promise<string> {
  const ds = payload<{ id: string }>(await call(builder, 'create_dataset', {
    name: 'Orders',
    columns: [{ name: 'order_id', description: 'PK' }, { name: 'net_amount', description: 'EUR' }, { name: 'customer_id', description: 'FK' }, { name: 'status', description: 'lifecycle' }],
  }));
  payload(await call(builder, 'add_dataset_version', { datasetId: ds.id, layer: 'bronze' }));
  payload(await call(builder, 'add_dataset_version', { datasetId: ds.id, layer: 'silver', body: 'select order_id, net_amount, customer_id, status from bronze' }));
  payload(await call(builder, 'add_dataset_version', { datasetId: ds.id, layer: 'gold', passThrough: true }));
  payload(await call(builder, 'document_dataset', { datasetId: ds.id, description: 'One row per order.' }));
  const req = payload<{ approvalId: string }>(await call(builder, 'request_promotion', { kind: 'dataset', id: ds.id }));
  payload(await call(builder, 'approve_promotion', { approvalId: req.approvalId }));
  return ds.id;
}

test('define_metric schema exposes the full measure model (approx distinct, filter, window, running total, ratio, format, drill)', () => {
  const tool = ALL_MCP_TOOLS.find((t) => t.name === 'define_metric');
  assert.ok(tool, 'define_metric is registered');
  const props = tool!.inputSchema.properties as Record<string, any>;
  assert.ok((props.aggregation.enum as string[]).includes('count_distinct_approx'), 'approx distinct offered');
  assert.ok((props.aggregation.enum as string[]).includes('number'), 'derived/ratio aggregation offered');
  for (const k of ['filter', 'runningTotal', 'rollingWindow', 'ratio', 'format', 'drillMembers']) {
    assert.ok(props[k], `schema exposes ${k}`);
  }
});

test('define_metric: count_distinct_approx registers as an approximate distinct measure', async () => {
  resetAll();
  const dsId = await goldOrders();
  const m = payload<{ measure: { type: string; sql: string }; cube: string }>(
    await call(builder, 'define_metric', { datasetId: dsId, name: 'Unique Customers', aggregation: 'count_distinct_approx', column: 'customer_id' }),
  );
  assert.equal(m.measure.type, 'count_distinct_approx');
  assert.equal(m.measure.sql, 'customer_id');
  assert.match(m.cube, /type: count_distinct_approx/);
});

test('define_metric: a filtered measure compiles a governed Cube filter predicate (no hand-written SQL)', async () => {
  resetAll();
  const dsId = await goldOrders();
  const m = payload<{ measure: { filters?: { sql: string }[] }; cube: string }>(
    await call(builder, 'define_metric', {
      datasetId: dsId,
      name: 'Completed Orders',
      aggregation: 'count',
      filter: { column: 'status', operator: 'equals', value: 'completed' },
    }),
  );
  assert.ok(m.measure.filters && m.measure.filters.length === 1, 'the filtered measure carries a filter');
  assert.match(m.measure.filters![0].sql, /\{CUBE\}\.status = 'completed'/);
  assert.match(m.cube, /filters:/);
});

test('define_metric: rollingWindow + format compile a trailing window and a display format', async () => {
  resetAll();
  const dsId = await goldOrders();
  const m = payload<{ measure: { rollingWindow?: { trailing?: string; offset?: string }; format?: string }; cube: string }>(
    await call(builder, 'define_metric', {
      datasetId: dsId,
      name: 'Trailing 7d Revenue',
      aggregation: 'sum',
      column: 'net_amount',
      rollingWindow: { amount: 7, unit: 'day' },
      format: 'currency',
    }),
  );
  assert.equal(m.measure.rollingWindow?.trailing, '7 day');
  assert.equal(m.measure.rollingWindow?.offset, 'end');
  assert.equal(m.measure.format, 'currency');
  assert.match(m.cube, /rolling_window:/);
  assert.match(m.cube, /format: currency/);
});

test('define_metric: runningTotal compiles an unbounded cumulative window', async () => {
  resetAll();
  const dsId = await goldOrders();
  const m = payload<{ measure: { rollingWindow?: { trailing?: string } } }>(
    await call(builder, 'define_metric', { datasetId: dsId, name: 'Cumulative Revenue', aggregation: 'sum', column: 'net_amount', runningTotal: true }),
  );
  assert.equal(m.measure.rollingWindow?.trailing, 'unbounded');
});

test('define_metric: a ratio (aggregation "number") compiles a derived measure over two other measures', async () => {
  resetAll();
  const dsId = await goldOrders();
  const m = payload<{ measure: { type: string; sql: string; format?: string } }>(
    await call(builder, 'define_metric', {
      datasetId: dsId,
      name: 'Conversion Rate',
      aggregation: 'number',
      ratio: { numerator: 'orders', denominator: 'sessions' },
      format: 'percent',
    }),
  );
  assert.equal(m.measure.type, 'number');
  assert.match(m.measure.sql, /1\.0 \* \{orders\} \/ \{sessions\}/);
  assert.equal(m.measure.format, 'percent');
});

test('define_metric: drillMembers are recorded for exploration', async () => {
  resetAll();
  const dsId = await goldOrders();
  const m = payload<{ measure: { drillMembers?: string[] }; cube: string }>(
    await call(builder, 'define_metric', {
      datasetId: dsId,
      name: 'Revenue',
      aggregation: 'sum',
      column: 'net_amount',
      drillMembers: ['order_id', 'customer_id'],
    }),
  );
  assert.deepEqual(m.measure.drillMembers, ['order_id', 'customer_id']);
  assert.match(m.cube, /drill_members: \[order_id, customer_id\]/);
});

test('define_metric: a "number" ratio with no numerator/denominator is a typed bad_request', async () => {
  resetAll();
  const dsId = await goldOrders();
  const e = errorOf(await call(builder, 'define_metric', { datasetId: dsId, name: 'Bad Ratio', aggregation: 'number' }));
  assert.equal(e.code, 'bad_request');
  assert.match(e.reason, /ratio|numerator|denominator/i);
});

test('define_metric: a plain measure still yields exactly {name,type,sql} (rich fields absent — back-compat)', async () => {
  resetAll();
  const dsId = await goldOrders();
  const m = payload<{ measure: Record<string, unknown> }>(
    await call(builder, 'define_metric', { datasetId: dsId, name: 'Revenue', aggregation: 'sum', column: 'net_amount' }),
  );
  assert.deepEqual(Object.keys(m.measure).sort(), ['name', 'sql', 'type']);
});
