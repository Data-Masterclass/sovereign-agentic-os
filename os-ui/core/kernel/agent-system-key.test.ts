/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The caps of an agent system's own LiteLLM key come from deployment config
 * USER STORY: As a platform admin I want the per-system key's budget, reset window and rate limits
 *             to come from deployment config, so I can change them without a code change.
 * ARCHITECTURE:
 *   - Reads `config.agentSystemKey` only; no gateway and no network. The defaults asserted here
 *     are the ones the chart block `osUI.agentSystemKey` ships.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { budgetDuration, config } from '@core/kernel/config';

test('agentSystemKey defaults: a WEEKLY-resetting $5 budget, 300 requests/min, 1,000,000 tokens/min', () => {
  assert.deepEqual(config.agentSystemKey, { maxBudget: 5, budgetDuration: '7d', rpmLimit: 300, tpmLimit: 1_000_000 });
});

test('budgetDuration: a LiteLLM duration passes; "none" turns the reset off; a typo falls back instead of becoming a lifetime cap', () => {
  assert.equal(budgetDuration('30d', '7d'), '30d');
  assert.equal(budgetDuration('24H', '7d'), '24h');
  assert.equal(budgetDuration('1mo', '7d'), '1mo');
  assert.equal(budgetDuration('', '7d'), '7d');
  assert.equal(budgetDuration('none', '7d'), '');
  assert.equal(budgetDuration('weekly', '7d'), '7d');
});
