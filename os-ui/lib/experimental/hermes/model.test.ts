/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HERMES_MODEL_TIERS,
  DEFAULT_HERMES_MODEL,
  selectHermesModel,
  validateToolCall,
  parseAndValidateToolCall,
  HERMES_WEIGHTS_LICENSE,
  type ToolCallSchema,
} from './model.ts';

test('14B is the CPU-feasible default; 36B/70B are GPU-pool gated off by default', () => {
  const cpu = HERMES_MODEL_TIERS.find((t) => t.model === DEFAULT_HERMES_MODEL)!;
  assert.equal(cpu.placement, 'cpu');
  assert.equal(cpu.gatedByDefault, false);
  for (const t of HERMES_MODEL_TIERS.filter((x) => x.placement === 'gpu-pool')) {
    assert.equal(t.gatedByDefault, true);
  }
});

test('model selection uses the CPU tier without a GPU pool, 36B with one', () => {
  assert.equal(selectHermesModel({ gpuPool: false }).model, 'hermes-4-3-14b');
  assert.equal(selectHermesModel({ gpuPool: true }).model, 'hermes-4-3-36b');
});

test('records the Llama-license note (weights are not MIT)', () => {
  assert.match(HERMES_WEIGHTS_LICENSE, /Llama 3\.1 Community License/);
  assert.match(HERMES_WEIGHTS_LICENSE, /do NOT redistribute/i);
});

const SCHEMAS: Record<string, ToolCallSchema> = {
  query_data: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] },
};

test('a schema-valid tool call passes; wrong types / missing required / unknown tool fail', () => {
  assert.equal(validateToolCall({ name: 'query_data', arguments: { sql: 'select 1' } }, SCHEMAS).valid, true);
  assert.equal(validateToolCall({ name: 'query_data', arguments: { sql: 42 } }, SCHEMAS).valid, false);
  assert.equal(validateToolCall({ name: 'query_data', arguments: {} }, SCHEMAS).valid, false);
  assert.equal(validateToolCall({ name: 'nope', arguments: {} }, SCHEMAS).valid, false);
});

test('parses a slightly noisy completion and validates the extracted JSON tool call', () => {
  const raw = 'Sure, calling the tool:\n{"name":"query_data","arguments":{"sql":"select count(*) from orders"}}\nDone.';
  const r = parseAndValidateToolCall(raw, SCHEMAS);
  assert.equal(r.valid, true);
  assert.equal(r.call?.name, 'query_data');
});

test('rejects a completion with no JSON object', () => {
  assert.equal(parseAndValidateToolCall('I cannot do that.', SCHEMAS).valid, false);
});
