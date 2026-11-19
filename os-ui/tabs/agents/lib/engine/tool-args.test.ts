/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ToolSpec } from '@core/runtime/agentic';
import { ALL_MCP_TOOLS } from '@core/mcp/server';
import { checkToolArgs, checkToolArgsJsonOnly, expectedShape } from '@tabs/agents/lib/engine/tool-args';

const SPEC: ToolSpec = {
  name: 'query_metric',
  description: 'evaluate',
  inputSchema: {
    type: 'object',
    properties: {
      metricId: { type: 'string' },
      dimensions: { type: 'array', items: { type: 'string' } },
      granularity: { type: 'string', enum: ['day', 'week', 'month'] },
      limit: { type: 'number' },
      strict: { type: 'boolean' },
      filter: { type: 'object', properties: { column: { type: 'string' }, value: { type: 'string' } }, required: ['column'] },
    },
    required: ['metricId'],
  },
};
const call = (args: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ id: 'c', name: 'query_metric', args, ...extra });
const problem = (args: Record<string, unknown>): string => {
  const v = checkToolArgs(call(args), SPEC);
  return v.ok ? '' : v.problem;
};

test('checkToolArgs: valid arguments pass unchanged; unknown extra fields are left to the tool', () => {
  const v = checkToolArgs(call({ metricId: 'ds.rev', dimensions: ['region'], granularity: 'month', limit: 10, extra: 1 }), SPEC);
  assert.deepEqual(v, { ok: true, args: { metricId: 'ds.rev', dimensions: ['region'], granularity: 'month', limit: 10, extra: 1 } });
});

test('checkToolArgs: required fields, types, enums, nested objects and array items are checked', () => {
  assert.match(problem({}), /missing required 'metricId'/);
  assert.match(problem({ metricId: null }), /missing required 'metricId'/);
  assert.match(problem({ metricId: 7 }), /'metricId' must be string \(got integer\)/);
  assert.match(problem({ metricId: 'm', granularity: 'hour' }), /'granularity' must be one of: day, week, month/);
  assert.match(problem({ metricId: 'm', dimensions: 'region' }), /'dimensions' must be array \(got string\)/);
  assert.match(problem({ metricId: 'm', dimensions: ['a', 3] }), /'dimensions\[1\]' must be string/);
  assert.match(problem({ metricId: 'm', filter: { value: 'x' } }), /missing required 'filter\.column'/);
});

test('checkToolArgs: a value written in the wrong JSON type is converted when nothing is lost — never defaulted', () => {
  const v = checkToolArgs(call({ metricId: 'm', limit: '25', strict: 'true', dimensions: '["region","day"]' }), SPEC);
  assert.deepEqual(v, { ok: true, args: { metricId: 'm', limit: 25, strict: true, dimensions: ['region', 'day'] } });
  assert.match(problem({ metricId: 'm', limit: 'many' }), /'limit' must be number \(got string\)/);
  assert.match(problem({ metricId: 'm', strict: 'yes' }), /'strict' must be boolean/);
});

test('checkToolArgs: broken argument JSON is refused with the reason, what was received and the expected shape', () => {
  const v = checkToolArgs(call({}, { argsError: 'Unexpected end of JSON input', rawArgs: '{"metricId": "ds.re' }), SPEC);
  assert.equal(v.ok, false);
  const error = (JSON.parse(v.ok ? '{}' : v.text) as { error: { code: string; reason: string; received: string; expected: { required: string[]; properties: Record<string, string> } } }).error;
  assert.equal(error.code, 'invalid_argument');
  assert.match(error.reason, /query_metric was NOT run: its arguments were not valid JSON \(Unexpected end of JSON input\)/);
  assert.equal(error.received, '{"metricId": "ds.re');
  assert.deepEqual(error.expected.required, ['metricId']);
  assert.equal(error.expected.properties.granularity, 'day | week | month');
  // The JSON-only check (frozen goldens) still refuses it, and lets a schema miss through.
  assert.equal(checkToolArgsJsonOnly(call({}, { argsError: 'x', rawArgs: '{' }), SPEC).ok, false);
  assert.equal(checkToolArgsJsonOnly(call({}), SPEC).ok, true);
});

test('expectedShape stays compact for the largest real tool schema', () => {
  for (const t of ALL_MCP_TOOLS) {
    const shape = expectedShape({ name: t.name, description: '', inputSchema: t.inputSchema as ToolSpec['inputSchema'] });
    assert.ok(JSON.stringify(shape).length < 1200, `${t.name}: the expected shape shown to the model is ${JSON.stringify(shape).length} chars`);
  }
});

test('every registered tool\'s own documented examples pass its schema', () => {
  // The schemas were never enforced before, so a schema stricter than its own examples would
  // start refusing calls the tool accepts. The examples are the registry's statement of a valid call.
  for (const t of ALL_MCP_TOOLS) {
    const schema = t.inputSchema as ToolSpec['inputSchema'] & { examples?: Record<string, unknown>[] };
    for (const example of schema.examples ?? []) {
      const v = checkToolArgs({ id: 'c', name: t.name, args: example }, { name: t.name, description: '', inputSchema: schema });
      assert.ok(v.ok, `${t.name}: its own example ${JSON.stringify(example).slice(0, 120)} fails its schema — ${v.ok ? '' : v.problem}`);
    }
  }
});
