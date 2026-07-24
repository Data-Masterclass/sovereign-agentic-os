/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseModelPrices } from './config.ts';

test('parseModelPrices parses a valid MODEL_PRICES_JSON map', () => {
  const p = parseModelPrices(
    '{"sovereign-default":{"inputPerM":0.1,"outputPerM":0.4},"sovereign-reasoning":{"inputPerM":2,"outputPerM":8}}',
  );
  assert.deepEqual(p, {
    'sovereign-default': { inputPerM: 0.1, outputPerM: 0.4 },
    'sovereign-reasoning': { inputPerM: 2, outputPerM: 8 },
  });
});

test('parseModelPrices defaults to {} (nothing priced) on empty/malformed input', () => {
  assert.deepEqual(parseModelPrices('{}'), {});
  assert.deepEqual(parseModelPrices(''), {});
  assert.deepEqual(parseModelPrices('not json'), {});
  assert.deepEqual(parseModelPrices('[1,2]'), {});
  assert.deepEqual(parseModelPrices('null'), {});
});

test('parseModelPrices drops entries with missing/non-finite/negative numbers', () => {
  const p = parseModelPrices(
    JSON.stringify({
      ok: { inputPerM: 0, outputPerM: 1.5 },
      missing: { inputPerM: 1 },
      negative: { inputPerM: -1, outputPerM: 1 },
      nan: { inputPerM: 'x', outputPerM: 1 },
      notObject: 3,
    }),
  );
  assert.deepEqual(p, { ok: { inputPerM: 0, outputPerM: 1.5 } });
});
