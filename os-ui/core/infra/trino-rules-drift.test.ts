/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    A hand edit of Trino's access rules is detected and reported, then repaired
 * USER STORY: As a platform admin I want to know when someone changed the Trino access rules outside
 *             the OS (the OS owns access rights, through OPA and the rules it writes), instead of the
 *             OS silently overwriting the edit.
 * ARCHITECTURE: the OS stamps the sha256 of what it wrote on the ConfigMap (annotation
 *             `os.sovereign/rules-sha256`). A later pass that finds the data no longer matches its
 *             own stamp has found a foreign edit: it still restores the rules, and records a drift.
 *             A membership change (desired differs, data still matches the stamp) is NOT drift, and
 *             neither is the very first write (no stamp yet).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileTrinoAccessRules, lastDrift, currentDrift, _resetReconcileOutcome, RULES_KEY, RULES_STAMP, RULES_DRIFT } from '@core/infra/trino-rules-server';
import { rulesInputFromDirectory } from '@core/infra/trino-rules';

const PATTERN = '[A-Za-z0-9][A-Za-z0-9._-]{0,63}';
const input = (users: { id: string; domains: string[] }[]) =>
  rulesInputFromDirectory({ serviceUsers: ['dbt-runner'], principalPattern: PATTERN, domains: ['sales'], users, sanitize: (s) => s.toLowerCase() });

type Store = { data: Record<string, string>; annotations: Record<string, string> };
function fake(store: Store) {
  return async (method: string, _p: string, body?: unknown) => {
    if (method === 'GET') return { status: 200, body: { data: store.data, metadata: { annotations: store.annotations } } };
    const b = body as { data?: Record<string, string>; metadata?: { annotations?: Record<string, string> } };
    store.data = { ...store.data, ...(b.data ?? {}) };
    store.annotations = { ...store.annotations, ...(b.metadata?.annotations ?? {}) };
    return { status: 200, body: {} };
  };
}

beforeEach(() => _resetReconcileOutcome());

test('the first write, and a later membership change, are not drift', async () => {
  const store: Store = { data: { [RULES_KEY]: '{"bootstrap":true}' }, annotations: {} };
  await reconcileTrinoAccessRules(input([{ id: 'amir', domains: ['sales'] }]), { k8s: fake(store) as never });
  assert.ok(store.annotations[RULES_STAMP], 'the OS stamps what it wrote');
  await reconcileTrinoAccessRules(input([{ id: 'amir', domains: ['sales'] }, { id: 'bea', domains: ['sales'] }]), { k8s: fake(store) as never });
  assert.equal(lastDrift(), null);
});

test('a hand edit after the OS wrote is restored AND recorded as drift', async () => {
  const store: Store = { data: { [RULES_KEY]: '{"bootstrap":true}' }, annotations: {} };
  const users = [{ id: 'amir', domains: ['sales'] }];
  await reconcileTrinoAccessRules(input(users), { k8s: fake(store) as never });
  const written = store.data[RULES_KEY];
  store.data[RULES_KEY] = '{"tables":[{"privileges":["OWNERSHIP"]}]}'; // a person opens everything up
  const out = await reconcileTrinoAccessRules(input(users), { k8s: fake(store) as never, now: () => 1_000 });
  assert.equal(out.ok && out.code, 'written');
  assert.equal(store.data[RULES_KEY], written, 'the rules are restored');
  const d = lastDrift();
  assert.ok(d, 'the drift is recorded');
  assert.equal(d!.at, 1_000);
  assert.equal(d!.restored, true);
});

test('twin: unchanged rules with a matching stamp record nothing', async () => {
  const store: Store = { data: { [RULES_KEY]: '{"bootstrap":true}' }, annotations: {} };
  const users = [{ id: 'amir', domains: ['sales'] }];
  await reconcileTrinoAccessRules(input(users), { k8s: fake(store) as never });
  await reconcileTrinoAccessRules(input(users), { k8s: fake(store) as never });
  assert.equal(lastDrift(), null);
});

test('a FAILED restore is recorded as a failed restore, never as "restored"', async () => {
  const store: Store = { data: { [RULES_KEY]: '{"bootstrap":true}' }, annotations: {} };
  const users = [{ id: 'amir', domains: ['sales'] }];
  await reconcileTrinoAccessRules(input(users), { k8s: fake(store) as never });
  store.data[RULES_KEY] = '{"tables":[{"privileges":["OWNERSHIP"]}]}';
  const inner = fake(store);
  const failing = async (m: string, p: string, b?: unknown) => (m === 'PATCH' ? { status: 500, body: {} } : inner(m, p, b));
  const out = await reconcileTrinoAccessRules(input(users), { k8s: failing as never, now: () => 2_000 });
  assert.equal(out.ok, false);
  assert.match(store.data[RULES_KEY], /OWNERSHIP/, 'the cluster still holds the foreign rules');
  const d = lastDrift();
  assert.ok(d);
  assert.equal(d!.restored, false);
  assert.match(d!.reason ?? '', /PATCH.*500/);
});

test('the drift record survives a restart: it is written with the repair and read back from the cluster', async () => {
  const store: Store = { data: { [RULES_KEY]: '{"bootstrap":true}' }, annotations: {} };
  const users = [{ id: 'amir', domains: ['sales'] }];
  await reconcileTrinoAccessRules(input(users), { k8s: fake(store) as never });
  store.data[RULES_KEY] = '{"x":1}';
  await reconcileTrinoAccessRules(input(users), { k8s: fake(store) as never, now: () => 3_000 });
  assert.ok(store.annotations[RULES_DRIFT], 'the repair carries the drift record');
  _resetReconcileOutcome(); // a restart: process memory is gone
  assert.equal(lastDrift(), null);
  const r = await currentDrift({ k8s: fake(store) as never });
  assert.ok(r.ok);
  assert.deepEqual(r.ok && r.drift && { at: r.drift.at, restored: r.drift.restored }, { at: 3_000, restored: true });
});

test('twin: a ConfigMap without a drift record reads back as no drift', async () => {
  const store: Store = { data: { [RULES_KEY]: '{}' }, annotations: {} };
  assert.deepEqual(await currentDrift({ k8s: fake(store) as never }), { ok: true, drift: null });
  // and an unreadable cluster is not "no drift"
  const down = await currentDrift({ k8s: (async () => ({ status: 0, body: {} })) as never });
  assert.equal(down.ok, false);
});
