/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       kernel
 * FEATURE:    Keep development secret fallbacks out of the client bundle (defence in depth)
 * USER STORY: As an operator I want moving the fallbacks out of the browser bundle to change no
 *             value a running server uses — the live system keeps exactly the values it had.
 * ARCHITECTURE:
 *   - Pins every server-side fallback to the literal config.ts carried before the move, and checks
 *     config resolves to it when the variable is unset (a server process: `window` undefined).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEV_SECRET_DEFAULTS } from '@core/kernel/dev-secret-defaults';
import { config, DEV_DEFAULT_SECRET, DEV_DEFAULT_AGENT_RUNTIME_TOKEN } from '@core/kernel/config';

const BEFORE = {
  sessionSecret: 'dev-only-insecure-session-secret-change-me-in-prod',
  agentRuntimeToken: 'dev-only-insecure-agent-runtime-token',
  litellmMasterKey: 'sk-litellm-local-dev-master',
  terminalBrokerSecret: 'dev-only-insecure-terminal-secret-change-me',
};

test('on the server every fallback is byte-for-byte the literal config.ts used before', () => {
  assert.equal(typeof window, 'undefined');
  assert.deepEqual({ ...DEV_SECRET_DEFAULTS }, BEFORE);
  assert.equal(DEV_DEFAULT_SECRET, BEFORE.sessionSecret);
  assert.equal(DEV_DEFAULT_AGENT_RUNTIME_TOKEN, BEFORE.agentRuntimeToken);
});

test('config resolves an unset variable to the same fallback, and an env value still wins', () => {
  const expectFallback = (name: string, actual: string, literal: string) => {
    if (process.env[name]) assert.equal(actual, process.env[name]);
    else assert.equal(actual, literal);
  };
  expectFallback('LITELLM_MASTER_KEY', config.litellmMasterKey, BEFORE.litellmMasterKey);
  expectFallback('TERMINAL_BROKER_SECRET', config.terminalBrokerSecret, BEFORE.terminalBrokerSecret);
  expectFallback('OS_SESSION_SECRET', config.sessionSecret, BEFORE.sessionSecret);
  expectFallback('AGENT_RUNTIME_TOKEN', config.agentRuntimeToken, BEFORE.agentRuntimeToken);
  if (!process.env.OS_MCP_TOKEN_SECRET && !process.env.OS_SESSION_SECRET) assert.equal(config.mcpTokenSecret, BEFORE.sessionSecret);
});
