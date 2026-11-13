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
import {
  reconcileTrinoAccessRules,
  startTrinoRulesReconciler,
  lastReconcileOutcome,
  _resetReconcileOutcome,
  RULES_KEY,
  type ReconcileOutcome,
} from '@core/infra/trino-rules-server';
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

// ------------------------------- B3 review round: the three triggers (H-2/H-3/H-4) ---

test('an outcome carries a stable code and a timestamp, and the last one is readable', async () => {
  _resetReconcileOutcome();
  assert.equal(lastReconcileOutcome(), null, 'nothing recorded before the first attempt');

  const { call } = fakeK8s({});
  const ok = await reconcileTrinoAccessRules(directory(), { namespace: 'ns', k8s: call, now: () => 1000 });
  assert.deepEqual([ok.ok, ok.code, ok.at], [true, 'written', 1000]);
  assert.deepEqual(lastReconcileOutcome(), ok);

  for (const [status, code] of [[0, 'no-cluster'], [404, 'no-configmap'], [403, 'forbidden'], [500, 'get-failed']] as const) {
    const bad = await reconcileTrinoAccessRules(directory(), { namespace: 'ns', k8s: fakeK8s({}, status).call, now: () => 2000 });
    assert.deepEqual([bad.ok, bad.code, bad.at], [false, code, 2000]);
    assert.equal(lastReconcileOutcome()?.code, code, 'the failure is the one a health row will read');
  }
});

test('a patch failure is a typed outcome too', async () => {
  const call = async (method: string) => (method === 'GET' ? { status: 200, body: { data: {} } } : { status: 409, body: {} });
  const out = await reconcileTrinoAccessRules(directory(), { namespace: 'ns', k8s: call });
  assert.deepEqual([out.ok, out.code], [false, 'patch-failed']);
});

/** A reconciler whose reconcile step is counted, with test-sized timings. */
function harness(outcomes: ReconcileOutcome[] = []) {
  const calls: string[] = [];
  const logs: string[] = [];
  let i = 0;
  const handle = startTrinoRulesReconciler({
    resolve: async () => directory(),
    reconcile: async () => {
      calls.push('reconcile');
      const out = outcomes[Math.min(i++, outcomes.length - 1)] ?? ({ ok: true, changed: true, code: 'written', detail: 'x', at: Date.now() } as ReconcileOutcome);
      return out;
    },
    debounceMs: 10,
    periodMs: 0, // the periodic pass is asserted separately
    backoffMs: 1,
    maxBackoffMs: 2,
    log: (level, message) => logs.push(`${level}:${message}`),
  });
  return { handle, calls, logs };
}

test('boot reconciles once; two rapid writes debounce into ONE further reconcile', async () => {
  const { handle, calls } = harness();
  await handle.idle();
  assert.equal(calls.length, 1, 'the boot pass');

  handle.trigger('user amir');
  handle.trigger('user bea'); // same debounce window
  await handle.idle();
  assert.equal(calls.length, 2, 'two rapid directory writes are ONE reconcile');

  handle.trigger('domain sales');
  await handle.idle();
  assert.equal(calls.length, 3, 'a later write is its own reconcile');
  handle.stop();
  handle.trigger('ignored after stop');
  await handle.idle();
  assert.equal(calls.length, 3, 'stop() means stop');
});

test('a failing pass retries with backoff, then records and warns once', async () => {
  const fail = { ok: false, changed: false, code: 'patch-failed', detail: 'PATCH → 500', at: 0 } as ReconcileOutcome;
  const { handle, calls, logs } = harness([fail, fail, fail]);
  await handle.idle();
  assert.equal(calls.length, 3, 'three attempts in one pass');
  assert.equal(logs.filter((l) => l.startsWith('warn:')).length, 1, 'one warn for the pass, not one per attempt');
  assert.match(logs.join('\n'), /NOT reconciled after 3 attempt\(s\).*patch-failed/);
  handle.stop();
});

test('a missing ConfigMap IS retried — at boot it is Helm object ordering, not a verdict (B4-review E-2)', async () => {
  // This test used to assert the opposite: one attempt, then give up, on the reading that
  // `no-configmap` / `no-cluster` are permanent configuration facts. At BOOT they are usually
  // transient — the ServiceAccount's Role may not have propagated and Helm does not order the
  // ConfigMap before the Deployment — and giving up left the chart's PERMISSIVE bootstrap as the
  // live access-control file until the 10-minute repair pass. So every failure code now gets the
  // pass's backoff, and a configmap that appears on the second attempt is reconciled at boot.
  const missing = { ok: false, changed: false, code: 'no-configmap', detail: 'gone', at: 0 } as ReconcileOutcome;
  const written = { ok: true, changed: true, code: 'written', detail: 'x', at: 0 } as ReconcileOutcome;
  const { handle, calls } = harness([missing, written]);
  await handle.idle();
  assert.equal(calls.length, 2, 'the second attempt found it and wrote the rules');
  handle.stop();
});

test('a cluster that never answers gives up after `attempts` and warns ONCE (B4-review E-2)', async () => {
  const none = { ok: false, changed: false, code: 'no-cluster', detail: 'no API', at: 0 } as ReconcileOutcome;
  const { handle, calls, logs } = harness([none]);
  await handle.idle();
  assert.equal(calls.length, 3, 'the default attempt budget, not an unbounded loop');
  const warnings = logs.filter((l) => l.startsWith('warn:'));
  assert.equal(warnings.length, 1, 'one warning per pass — a laptop must not fill the log');
  assert.match(warnings[0], /no-cluster/);
  assert.match(warnings[0], /bootstrap still applies/);
  handle.stop();
});

test('the periodic pass repairs a helm upgrade that reset the key', async () => {
  // The chart owns the bootstrap VALUE, so `helm upgrade` rewrites it; no OS event fires for that.
  const store: { data?: Record<string, string> } = {};
  const { call, calls } = fakeK8s(store);
  const handle = startTrinoRulesReconciler({
    resolve: async () => directory(),
    reconcile: (input) => reconcileTrinoAccessRules(input, { namespace: 'ns', k8s: call }),
    debounceMs: 1,
    periodMs: 15,
    jitterMs: 0,
    log: () => {},
  });
  await handle.idle();
  const reconciled = store.data![RULES_KEY];
  store.data = { [RULES_KEY]: '{"catalogs":[{"allow":"all"}]}\n' }; // what Helm just put back
  await new Promise((r) => setTimeout(r, 60));
  await handle.idle();
  handle.stop();
  assert.equal(store.data![RULES_KEY], reconciled, 'the repair pass restored the enumerated file');
  assert.ok(calls.filter((c) => c.method === 'PATCH').length >= 2, 'it patched again');
});
