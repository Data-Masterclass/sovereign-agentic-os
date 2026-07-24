/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { combine, pipelineHealth, dqHealth, agentRunHealth, ageInDays } from './artifact-health-core.ts';

test('combine takes the worse of two, ignoring grey (no-signal)', () => {
  assert.equal(combine('green', 'green'), 'green');
  assert.equal(combine('green', 'amber'), 'amber');
  assert.equal(combine('amber', 'red'), 'red');
  assert.equal(combine('green', 'grey'), 'green', 'a real signal beats no-signal');
  assert.equal(combine('grey', 'grey'), 'grey', 'nothing known → grey');
  assert.equal(combine('grey', 'red'), 'red');
});

test('pipelineHealth: never-built → grey; then by staleness', () => {
  assert.equal(pipelineHealth(false, null), 'grey', 'nothing built');
  assert.equal(pipelineHealth(true, null), 'grey', 'built but no parseable date');
  assert.equal(pipelineHealth(true, 0), 'green', 'fresh today');
  assert.equal(pipelineHealth(true, 7), 'green', '7d still green');
  assert.equal(pipelineHealth(true, 8), 'amber', '>7d stale');
  assert.equal(pipelineHealth(true, 31), 'red', '>30d very stale');
});

test('dqHealth maps the DQ badge', () => {
  assert.equal(dqHealth('passing'), 'green');
  assert.equal(dqHealth('failing'), 'red');
  assert.equal(dqHealth('unknown'), 'grey', 'no checks → no signal');
});

test('agentRunHealth: never-run grey, failed red, ok-with-holds amber, clean green', () => {
  assert.equal(agentRunHealth(null, 0), 'grey', 'never run');
  assert.equal(agentRunHealth(false, 0), 'red', 'last run failed');
  assert.equal(agentRunHealth(true, 3), 'amber', 'succeeded but held tool calls');
  assert.equal(agentRunHealth(true, 0), 'green', 'clean success');
});

test('a healthy fresh + passing dataset rolls up green; a stale failing one rolls up red', () => {
  const now = Date.UTC(2026, 6, 24);
  const fresh = ageInDays(new Date(now - 2 * 86_400_000).toISOString(), now); // 2 days
  const stale = ageInDays(new Date(now - 40 * 86_400_000).toISOString(), now); // 40 days
  assert.equal(combine(pipelineHealth(true, fresh), dqHealth('passing')), 'green');
  assert.equal(combine(pipelineHealth(true, stale), dqHealth('failing')), 'red');
  // Built + fresh but no DQ checks yet → pipeline green wins over grey DQ.
  assert.equal(combine(pipelineHealth(true, fresh), dqHealth('unknown')), 'green');
});
