/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * FAIL-CLOSED test for the governed AGENT authz spine. When OPA is unreachable,
 * `authorize()` must DENY by default (config.opaFailOpen is false) — mirroring the
 * data spine (lib/infra/governed.ts) — so an OPA outage cannot silently open agent
 * tool authz via the static LOCAL_GRANTS mirror. Only when OPA_FAIL_OPEN=true (the
 * offline-mock teaching flow) does the local grant mirror apply.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { authorize } from './agent-governed.ts';
import { config } from '@/lib/core/config';

const realFetch = globalThis.fetch;
const realFailOpen = config.opaFailOpen;
afterEach(() => {
  globalThis.fetch = realFetch;
  config.opaFailOpen = realFailOpen;
});

// sales-assistant IS granted `metrics` in the LOCAL_GRANTS mirror — so if the
// fallback were ungated it would return allow. That makes it the sharp test case.

test('SECURITY: OPA unreachable + opaFailOpen=false => DENY (fail closed) even for a locally-granted tool', async () => {
  config.opaFailOpen = false;
  globalThis.fetch = (async () => {
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof fetch;
  const d = await authorize('sales-assistant', 'metrics');
  assert.equal(d.effect, 'deny', 'unreachable OPA must deny by default');
  assert.equal(d.policy, 'opa-unreachable');
});

test('SECURITY: OPA malformed body + opaFailOpen=false => DENY (fail closed)', async () => {
  config.opaFailOpen = false;
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => {
      throw new Error('not json');
    },
  })) as unknown as typeof fetch;
  const d = await authorize('sales-assistant', 'metrics');
  assert.equal(d.effect, 'deny', 'a body-parse error must deny, not fall back to the local grant');
  assert.equal(d.policy, 'opa-unreachable');
});

test('OPA unreachable + opaFailOpen=true => legacy LOCAL_GRANTS mirror (allow for a granted tool)', async () => {
  config.opaFailOpen = true;
  globalThis.fetch = (async () => {
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof fetch;
  const d = await authorize('sales-assistant', 'metrics');
  assert.equal(d.effect, 'allow', 'the offline teaching flow keeps the local grant mirror');
  assert.equal(d.policy, 'opa-unreachable');
});

test('OPA unreachable + opaFailOpen=true => local mirror still denies an ungranted tool', async () => {
  config.opaFailOpen = true;
  globalThis.fetch = (async () => {
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof fetch;
  const d = await authorize('finance', 'connection_crm_write');
  assert.equal(d.effect, 'deny');
  assert.equal(d.policy, 'opa-unreachable');
});

test('a live OPA allow decision is honored regardless of opaFailOpen', async () => {
  config.opaFailOpen = false;
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({ result: { effect: 'allow', reason: 'ok' } }),
  })) as unknown as typeof fetch;
  const d = await authorize('sales-assistant', 'metrics');
  assert.equal(d.effect, 'allow');
  assert.equal(d.policy, 'opa-allow');
});

test('a live OPA deny decision is honored (unchanged when reachable)', async () => {
  config.opaFailOpen = true; // even fail-open must not override a live deny
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({ result: { effect: 'deny', reason: 'nope' } }),
  })) as unknown as typeof fetch;
  const d = await authorize('sales-assistant', 'metrics');
  assert.equal(d.effect, 'deny');
  assert.equal(d.policy, 'opa-deny');
});
