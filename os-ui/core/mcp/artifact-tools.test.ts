/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@core/kernel/auth';
import { ALL_MCP_TOOLS, handleRpc, listToolsForRole, type McpTool } from '@core/mcp/server';
import { ARTIFACT_OUTPUT_SCHEMA, parseArtifacts, tableArtifact } from '@core/runtime/chat-artifacts';

/**
 * AREA:       mcp
 * FEATURE:    `outputSchema` + `structuredContent` on the six artifact-producing read tools (C7).
 *
 * USER STORY: As an external MCP client I want the SAME validated artifact payload the
 *             Ask-the-OS drawer renders, declared on the tool so I can validate it — not a
 *             second, UI-only serialiser that drifts from the one I am given.
 *
 * ARCHITECTURE:
 *   Three things are pinned here:
 *     (a) THE SIX tools declare `ARTIFACT_OUTPUT_SCHEMA` and an `artifacts` projection, and
 *         `tools/list` carries the schema on the wire (a client cannot validate a schema it
 *         was never sent).
 *     (b) Each projection, fed a realistic result from its own tool, produces artifacts that
 *         conform — and the truncation fields survive the projection, which is the whole
 *         point of the exercise.
 *     (c) The DISPATCHER wiring: a tool with a projection gets `structuredContent`, a tool
 *         without one is byte-identical to before, and a projection that THROWS degrades to
 *         "no artifacts" rather than turning a successful governed read into an error.
 *         Driven through the real `handleRpc` with a scoped tool list, which is the lens a
 *         per-tab MCP endpoint already uses — no registry mutation.
 */

const creator: CurrentUser = { id: 'u-42', name: 'Robin', domains: ['sales'], role: 'creator' };

/** The six read tools D14 names, with a realistic result + args for each projection. */
const SIX: { tool: string; result: unknown; args: Record<string, unknown> }[] = [
  {
    tool: 'query_data',
    args: { sql: 'select region, sum(net_amount) from orders group by 1' },
    result: {
      principal: 'sales',
      authorized: true,
      engine: 'trino',
      columns: ['region', 'total'],
      rows: [['DE', '80210'], ['FR', '48240']],
      rowCount: 1000,
      truncated: true,
      rowLimit: 1000,
      message: 'Result clipped at QUERY_MAX_ROWS=1000. These are the first 1000 rows, not a sample.',
    },
  },
  {
    tool: 'query_metric',
    args: { metricId: 'ds_ab12cd.revenue', dimensions: ['region'] },
    result: {
      metricId: 'ds_ab12cd.revenue',
      member: 'OrdersV1.revenue',
      value: 128450,
      rows: [{ 'OrdersV1.region': 'DE', 'OrdersV1.revenue': 80210 }],
      mode: 'live',
      securityContext: { sub: 'u-42' },
    },
  },
  {
    tool: 'preview_metric',
    args: { datasetId: 'ds_ab12cd', name: 'Revenue', aggregation: 'sum', column: 'net_amount', dimensions: ['region'] },
    result: {
      datasetId: 'ds_ab12cd',
      measure: { name: 'Revenue', type: 'sum', sql: 'net_amount' },
      member: 'OrdersV1.revenue',
      rows: [{ 'OrdersV1.region': 'DE', 'OrdersV1.revenue': 80210 }],
      mode: 'live (sql)',
      sql: 'SELECT region, sum(net_amount) FROM iceberg.sales.gold_orders GROUP BY 1',
      securityContext: { sub: 'u-42' },
    },
  },
  {
    tool: 'suggest_metrics',
    args: {},
    result: {
      candidates: [
        {
          name: 'Revenue',
          description: 'Net revenue',
          why: 'the company goal names it',
          datasetId: 'ds_ab12cd',
          form: { name: 'Revenue', aggregation: 'sum', column: 'net_amount', dimensions: ['region'] },
        },
      ],
      grounding: { omSections: 2, workflows: 1, datasets: 3 },
    },
  },
  {
    tool: 'get_metric',
    args: { metricId: 'ds_ab12cd.revenue' },
    result: {
      id: 'ds_ab12cd.revenue',
      name: 'Revenue',
      member: 'OrdersV1.revenue',
      tier: 'domain',
      owner: 'u-42',
      datasetId: 'ds_ab12cd',
      datasetName: 'orders_v1',
      definition: { aggregation: 'sum', column: 'net_amount', dimensions: ['region'] },
      definitionYaml: 'measures:\n  - name: revenue\n',
    },
  },
  {
    tool: 'get_dashboard',
    args: { dashboardId: 'dash_sales_ab12cd' },
    result: {
      id: 'dash_sales_ab12cd',
      name: 'Sales overview',
      view: 'OrdersV1',
      tier: 'personal',
      owner: 'u-42',
      domain: 'sales',
      charts: [{ name: 'Revenue by region', vizType: 'bar', metrics: ['OrdersV1.revenue'], dimensions: ['OrdersV1.region'] }],
    },
  },
];

/** Minimal structural validator for the schema subset the artifact schema uses. */
function validate(schema: Record<string, unknown>, value: unknown, path = '$'): string[] {
  const errs: string[] = [];
  const type = schema.type as string | undefined;
  if (type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${path}: expected object`];
    const obj = value as Record<string, unknown>;
    for (const req of (schema.required as string[] | undefined) ?? []) {
      if (!(req in obj)) errs.push(`${path}.${req}: required`);
    }
    const props = (schema.properties as Record<string, Record<string, unknown>> | undefined) ?? {};
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined) continue;
      if (props[k]) errs.push(...validate(props[k], v, `${path}.${k}`));
      else if (schema.additionalProperties === false) errs.push(`${path}.${k}: not allowed`);
    }
    return errs;
  }
  if (type === 'array') {
    if (!Array.isArray(value)) return [`${path}: expected array`];
    const items = schema.items as Record<string, unknown> | undefined;
    if (items) value.forEach((v, i) => errs.push(...validate(items, v, `${path}[${i}]`)));
    return errs;
  }
  const enumVals = schema.enum as unknown[] | undefined;
  if (enumVals && !enumVals.includes(value)) errs.push(`${path}: ${String(value)} not in enum`);
  if (type === 'string' && typeof value !== 'string') errs.push(`${path}: expected string`);
  if (type === 'number' && typeof value !== 'number') errs.push(`${path}: expected number`);
  if (type === 'boolean' && typeof value !== 'boolean') errs.push(`${path}: expected boolean`);
  return errs;
}

function byName(name: string): McpTool {
  const t = ALL_MCP_TOOLS.find((x) => x.name === name);
  assert.ok(t, `${name} is not registered`);
  return t;
}

// ------------------------------------------------------------------- (a) declared ----

test('C7: the six read tools declare the artifact outputSchema and a projection', () => {
  for (const { tool } of SIX) {
    const t = byName(tool);
    assert.equal(t.outputSchema, ARTIFACT_OUTPUT_SCHEMA, `${tool} does not declare the artifact outputSchema`);
    assert.equal(typeof t.artifacts, 'function', `${tool} declares no artifact projection`);
  }
});

test('C7: tools/list carries outputSchema on the wire for the six, and omits it elsewhere', () => {
  const wire = listToolsForRole('creator');
  const names = new Set(SIX.map((s) => s.tool));
  for (const row of wire) {
    if (names.has(row.name)) {
      assert.ok(row.outputSchema, `${row.name} must advertise outputSchema so a client can validate`);
    } else {
      assert.equal('outputSchema' in row, false, `${row.name} declares no projection; it must not advertise a schema`);
    }
  }
  // Every one of the six must actually be visible to a creator — the lowest role.
  for (const { tool } of SIX) assert.ok(wire.some((r) => r.name === tool), `${tool} is not creator-visible`);
});

// ------------------------------------------------------------------ (b) conforming ----

test('C7: every projection produces artifacts that conform to the advertised schema', () => {
  for (const { tool, result, args } of SIX) {
    const t = byName(tool);
    const artifacts = t.artifacts?.(result, args) ?? [];
    assert.ok(artifacts.length > 0, `${tool} produced no artifacts for a realistic result`);
    const errs = validate(ARTIFACT_OUTPUT_SCHEMA as unknown as Record<string, unknown>, { artifacts });
    assert.deepEqual(errs, [], `${tool}: ${errs.join('; ')}`);
    // And it must survive the wire round-trip the client actually performs.
    const back = parseArtifacts(JSON.parse(JSON.stringify({ artifacts })));
    assert.equal(back.length, artifacts.length, `${tool} lost artifacts on round-trip`);
  }
});

test('C5: query_data\'s projection carries the truncation fields verbatim', () => {
  const spec = SIX[0];
  const artifacts = byName('query_data').artifacts?.(spec.result, spec.args) ?? [];
  const table = artifacts.find((a) => a.kind === 'table');
  assert.ok(table && table.kind === 'table');
  if (!table || table.kind !== 'table') return;
  assert.equal(table.truncated, true);
  assert.equal(table.rowLimit, 1000);
  assert.match(table.message ?? '', /first 1000 rows, not a sample/);
  assert.equal(table.rowCount, 1000, 'the tool-reported count, not the clipped rows.length');
  assert.equal(table.source, 'ad-hoc-sql', 'an SQL answer must be labelled ad-hoc');
  assert.equal(table.sql, spec.args.sql, 'the SQL that ran must be shown');
});

test('C6/C-R2.1: a semantic-layer answer is NOT labelled ad-hoc and cites its metric', () => {
  const spec = SIX[1];
  const artifacts = byName('query_metric').artifacts?.(spec.result, spec.args) ?? [];
  const table = artifacts.find((a) => a.kind === 'table');
  assert.ok(table && table.kind === 'table' && table.source === 'semantic-layer');
  const citation = artifacts.find((a) => a.kind === 'citation');
  assert.ok(citation && citation.kind === 'citation' && citation.of === 'metric');
  assert.equal(citation.kind === 'citation' && citation.id, 'ds_ab12cd.revenue');
});

test('C7: a projection never invents a number — every cell traces to the tool result', () => {
  const spec = SIX[1];
  const artifacts = byName('query_metric').artifacts?.(spec.result, spec.args) ?? [];
  const table = artifacts.find((a) => a.kind === 'table');
  assert.ok(table && table.kind === 'table');
  if (!table || table.kind !== 'table') return;
  assert.deepEqual(table.rows, [['DE', '80210']]);
  // Not a total, not a rounding, not a derived figure: the rows the tool returned.
  assert.equal(table.rows.flat().includes('128450'), false, 'the scalar must not be fabricated into a row');
});

test('C7: a projection fed an EMPTY or malformed result degrades to nothing, never throws', () => {
  for (const { tool, args } of SIX) {
    const t = byName(tool);
    for (const junk of [null, undefined, {}, [], 'x', 0]) {
      assert.doesNotThrow(() => t.artifacts?.(junk, args), `${tool} threw on ${JSON.stringify(junk)}`);
    }
  }
});

// -------------------------------------------------------------- (c) the dispatcher ----

const fakeTable = {
  columns: ['a'],
  rows: [['1']],
  rowCount: 7,
  truncated: true,
  rowLimit: 7,
  message: 'clipped at 7',
};

const withProjection: McpTool = {
  name: 'fixture_with_artifacts',
  description: 'fixture',
  minRole: 'creator',
  tab: 'data',
  inputSchema: { type: 'object', properties: {} },
  outputSchema: ARTIFACT_OUTPUT_SCHEMA,
  artifacts: (result) => [tableArtifact(result, { source: 'ad-hoc-sql', sql: 'select 1' })],
  call: async () => fakeTable,
};

const withoutProjection: McpTool = {
  name: 'fixture_plain',
  description: 'fixture',
  minRole: 'creator',
  tab: 'data',
  inputSchema: { type: 'object', properties: {} },
  call: async () => ({ ok: true }),
};

const throwingProjection: McpTool = {
  name: 'fixture_throws',
  description: 'fixture',
  minRole: 'creator',
  tab: 'data',
  inputSchema: { type: 'object', properties: {} },
  outputSchema: ARTIFACT_OUTPUT_SCHEMA,
  artifacts: () => {
    throw new Error('projection bug');
  },
  call: async () => ({ ok: true }),
};

async function callFixture(tool: McpTool) {
  const res = await handleRpc(
    creator,
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool.name, arguments: {} } },
    { tools: [tool] },
  );
  return (res.result ?? {}) as { content?: { text?: string }[]; structuredContent?: unknown; isError?: boolean };
}

test('C7: tools/call returns structuredContent when the tool declares a projection', async () => {
  const result = await callFixture(withProjection);
  assert.equal(result.isError, undefined);
  const artifacts = parseArtifacts(result.structuredContent);
  assert.equal(artifacts.length, 1);
  const t = artifacts[0];
  assert.ok(t.kind === 'table' && t.truncated === true && t.rowLimit === 7 && t.message === 'clipped at 7');
  // The text block is unchanged — the model sees exactly what it saw before.
  assert.match(result.content?.[0]?.text ?? '', /"rowCount": 7/);
});

test('C7: a tool with NO projection is byte-identical to before (no empty envelope)', async () => {
  const result = await callFixture(withoutProjection);
  assert.equal('structuredContent' in result, false);
  assert.deepEqual(Object.keys(result), ['content']);
});

test('C7: a THROWING projection degrades to no artifacts — the governed read still succeeds', async () => {
  const result = await callFixture(throwingProjection);
  assert.equal(result.isError, undefined, 'a renderer bug must never fail a governed read');
  assert.equal('structuredContent' in result, false);
  assert.match(result.content?.[0]?.text ?? '', /"ok": true/);
});

test('C7: a governance DENIAL carries its typed error, never artifacts', async () => {
  const adminOnly: McpTool = { ...withProjection, name: 'fixture_admin', minRole: 'admin' };
  const result = await callFixture(adminOnly);
  assert.equal(result.isError, true);
  const err = (result.structuredContent as { error?: { code?: string } })?.error;
  assert.equal(err?.code, 'forbidden');
  assert.deepEqual(parseArtifacts(result.structuredContent), [], 'a denial must yield no artifacts');
});
