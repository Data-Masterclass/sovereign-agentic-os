/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * FAIL-CLOSED test for the governed DATA authz spine. When OPA is unreachable or
 * errors, `authorize()` must DENY by default (config.opaFailOpen is false unless
 * OPA_FAIL_OPEN=true is explicitly set for the offline-mock teaching flow) — so an
 * OPA outage cannot silently open every metrics/query authz. Aligns with the agent
 * spine's default-deny.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { authorize } from './governed.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test('SECURITY: OPA unreachable (network error) => DENY (fail closed)', async () => {
  globalThis.fetch = (async () => {
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof fetch;
  const decision = await authorize('sales', 'query');
  assert.equal(decision.allowed, false, 'unreachable OPA must deny by default');
  assert.equal(decision.policy, 'opa-unreachable');
});

test('SECURITY: OPA returns malformed body => DENY (fail closed)', async () => {
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => {
      throw new Error('not json');
    },
  })) as unknown as typeof fetch;
  const decision = await authorize('sales', 'query');
  assert.equal(decision.allowed, false, 'a body-parse error must deny, not allow');
  assert.equal(decision.policy, 'opa-unreachable');
});

test('a live OPA allow decision is honored', async () => {
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({ result: true }),
  })) as unknown as typeof fetch;
  const decision = await authorize('sales', 'query');
  assert.equal(decision.allowed, true);
  assert.equal(decision.policy, 'opa-allow');
});

test('a live OPA deny decision is honored', async () => {
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({ result: false }),
  })) as unknown as typeof fetch;
  const decision = await authorize('sales', 'query');
  assert.equal(decision.allowed, false);
  assert.equal(decision.policy, 'opa-deny');
});
