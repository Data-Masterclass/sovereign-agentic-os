/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Tests for the Trino rules ConfigMap reconciler (engine rebuild B3)
 * USER STORY: As a reviewer I want proof that a membership change rewrites the rules file exactly
 *             once, that an unchanged state writes nothing, and that every failure mode (no cluster,
 *             no ConfigMap, forbidden) is a typed outcome rather than a throw.
 * ARCHITECTURE: The Kubernetes call is injected, so this runs with no cluster and no RBAC.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileTrinoAccessRules, RULES_KEY } from '@core/infra/trino-rules-server';
import { rulesInputFromDirectory, buildTrinoRules, renderTrinoRules, impersonationAllowed, schemaOwnerAllowed } from '@core/infra/trino-rules';

const PATTERN = '[A-Za-z0-9][A-Za-z0-9._-]{0,63}';

function directory() {
  return rulesInputFromDirectory({
    serviceUsers: ['dbt-runner'],
    principalPattern: PATTERN,
    domains: ['sales', 'finance'],
    users: [
      { id: 'amir', domains: ['sales'] },
      { id: 'bea', domains: ['sales', 'finance'] },
      { id: 'gone', domains: ['sales'], disabled: true },
    ],
    sanitize: (s) => s.replace(/[^a-z0-9_]/gi, '_').toLowerCase(),
  });
}

function fakeK8s(store: { data?: Record<string, string> }, status = 200) {
  const calls: { method: string; body?: unknown }[] = [];
  const call = async (method: string, _path: string, body?: unknown) => {
    calls.push({ method, body });
    if (method === 'GET') return { status, body: { data: store.data ?? {} } };
    store.data = { ...(store.data ?? {}), ...((body as { data?: Record<string, string> }).data ?? {}) };
    return { status: 200, body: {} };
  };
  return { call, calls };
}

test('a disabled user loses their personal lane and their domain membership', () => {
  const input = directory();
  assert.deepEqual(input.personalLanes.map((l) => l.uid), ['amir', 'bea']);
  assert.deepEqual(input.domains, [
    { name: 'finance', schema: 'finance', principals: ['bea'] },
    { name: 'sales', schema: 'sales', principals: ['amir', 'bea'] },
  ]);
  const rules = buildTrinoRules(input);
  assert.equal(schemaOwnerAllowed(rules, 'bea', 'finance'), true);
  assert.equal(schemaOwnerAllowed(rules, 'amir', 'finance'), false);
  assert.equal(impersonationAllowed(rules, 'dbt-runner', 'gone'), false, 'a deactivated principal must not be impersonable');
});

test('reconcile writes once, then is a no-op until the membership changes', async () => {
  const store: { data?: Record<string, string> } = {};
  const { call, calls } = fakeK8s(store);
  const first = await reconcileTrinoAccessRules(directory(), { namespace: 'ns', k8s: call });
  assert.deepEqual([first.ok, first.changed], [true, true]);
  assert.equal(store.data?.[RULES_KEY], renderTrinoRules(buildTrinoRules(directory())));
  assert.deepEqual(calls.map((c) => c.method), ['GET', 'PATCH']);

  const second = await reconcileTrinoAccessRules(directory(), { namespace: 'ns', k8s: call });
  assert.deepEqual([second.ok, second.changed], [true, false]);
  assert.deepEqual(calls.map((c) => c.method), ['GET', 'PATCH', 'GET'], 'unchanged rules must not be patched');

  const withNewUser = rulesInputFromDirectory({
    serviceUsers: ['dbt-runner'],
    principalPattern: PATTERN,
    domains: ['sales', 'finance'],
    users: [{ id: 'amir', domains: ['sales'] }, { id: 'bea', domains: ['sales', 'finance'] }, { id: 'cleo', domains: ['finance'] }],
    sanitize: (s) => s,
  });
  const third = await reconcileTrinoAccessRules(withNewUser, { namespace: 'ns', k8s: call });
  assert.deepEqual([third.ok, third.changed], [true, true]);
  assert.match(store.data![RULES_KEY], /personal_cleo/);
});

test('every failure mode is a typed outcome, never a throw', async () => {
  for (const [status, needle] of [[0, 'no Kubernetes API'], [404, 'does not exist'], [403, 'forbidden'], [500, '→ 500']] as const) {
    const { call } = fakeK8s({}, status);
    const out = await reconcileTrinoAccessRules(directory(), { namespace: 'ns', k8s: call });
    assert.equal(out.ok, false, `status ${status}`);
    assert.equal(out.changed, false);
    assert.ok(out.detail.includes(String(needle)), `${status}: ${out.detail}`);
  }
});

test('the reconciled file carries no secret', async () => {
  const store: { data?: Record<string, string> } = {};
  const { call } = fakeK8s(store);
  await reconcileTrinoAccessRules(directory(), { namespace: 'ns', k8s: call });
  assert.doesNotMatch(store.data![RULES_KEY], /password|secret|token|credential/i);
});
