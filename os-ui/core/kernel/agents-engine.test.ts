/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       kernel
 * FEATURE:    Tests for the agent ENGINE flag parser
 * USER STORY: As a maintainer I want proof that AGENTS_ENGINE parses both engines, tolerates
 *             case/whitespace, and falls back to the walker on anything else.
 * ARCHITECTURE:
 *   - Pure unit tests over `parseAgentsEngine` / `isAgentsEngine`; no env mutation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAgentsEngine, isAgentsEngine, DEFAULT_AGENTS_ENGINE, AGENTS_ENGINES } from '@core/kernel/agents-engine';

test('the default engine is the walker until Phase A5 flips it', () => {
  assert.equal(DEFAULT_AGENTS_ENGINE, 'walker');
  assert.deepEqual([...AGENTS_ENGINES], ['walker', 'langgraph']);
});

test('parseAgentsEngine accepts both engines, case- and whitespace-insensitively', () => {
  assert.equal(parseAgentsEngine('walker'), 'walker');
  assert.equal(parseAgentsEngine('langgraph'), 'langgraph');
  assert.equal(parseAgentsEngine('  LangGraph '), 'langgraph');
});

test('parseAgentsEngine falls back to the walker for unset, empty or unknown values', () => {
  assert.equal(parseAgentsEngine(undefined), 'walker');
  assert.equal(parseAgentsEngine(''), 'walker');
  assert.equal(parseAgentsEngine('python'), 'walker');
  assert.equal(parseAgentsEngine('hermes'), 'walker');
});

test('isAgentsEngine is a strict type guard', () => {
  assert.equal(isAgentsEngine('walker'), true);
  assert.equal(isAgentsEngine('langgraph'), true);
  assert.equal(isAgentsEngine('LANGGRAPH'), false);
  assert.equal(isAgentsEngine(1), false);
  assert.equal(isAgentsEngine(null), false);
});
