/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE: tests for the CloudNativePG adapter (core/adapters/cnpg/client.ts, App Builder D).
 * USER STORY: as an operator I want proof that adding an app's role never drops another app's role, that a concurrent
 *   change is detected instead of overwritten, and that every failure is typed.
 * ARCHITECTURE: Kubernetes is a recorded fake answering with the API's own status codes; the real-cluster proof is
 *   tabs/software/lib/appdb/appdb.kind.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appRoleSpec, databaseManifest, ensureDatabase, ensureManagedRole, jobState, readCluster, roleState, type CnpgK8s } from './client.ts';

const CL = '/apis/postgresql.cnpg.io/v1/namespaces/apps-dev/clusters/apps-pg';

function clusterK8s(initial: { roles: unknown[]; rv?: number; conflicts?: number }) {
  let rv = initial.rv ?? 7;
  let roles = initial.roles;
  let conflicts = initial.conflicts ?? 0;
  const calls: { method: string; body?: unknown }[] = [];
  const k8s: CnpgK8s = async (method, path, body) => {
    calls.push({ method, body });
    if (path !== CL) return { status: 404, body: {} };
    if (method === 'GET') return { status: 200, body: { metadata: { resourceVersion: String(rv) }, spec: { imageName: 'pg@sha256:x', instances: 1, managed: { roles } }, status: { phase: 'Cluster in healthy state', readyInstances: 1, managedRolesStatus: { byStatus: { reconciled: ['app_a'] } } } } };
    if (method === 'PATCH') {
      const b = body as { metadata: { resourceVersion: string }; spec: { managed: { roles: unknown[] } } };
      if (conflicts > 0) { conflicts--; rv++; return { status: 409, body: {} }; }
      if (b.metadata.resourceVersion !== String(rv)) return { status: 409, body: {} };
      roles = b.spec.managed.roles; rv++;
      return { status: 200, body: {} };
    }
    return { status: 405, body: {} };
  };
  return { k8s, calls, roles: () => roles };
}

test('a new app role is ADDED next to the existing ones, guarded by the read resourceVersion', async () => {
  const other = appRoleSpec('app_other', 'app-other-db');
  const f = clusterK8s({ roles: [other] });
  const r = await ensureManagedRole(f.k8s, 'apps-dev', 'apps-pg', appRoleSpec('app_a', 'app-a-db'));
  assert.deepEqual(r.ok && r.value, { changed: true });
  assert.deepEqual(f.roles().map((x) => (x as { name: string }).name), ['app_other', 'app_a']);
  const patch = f.calls.find((c) => c.method === 'PATCH')!.body as { metadata: { resourceVersion: string } };
  assert.equal(patch.metadata.resourceVersion, '7');
});

test('the same role again changes nothing; a role with other fields is replaced in place', async () => {
  const f = clusterK8s({ roles: [appRoleSpec('app_a', 'app-a-db')] });
  const same = await ensureManagedRole(f.k8s, 'apps-dev', 'apps-pg', appRoleSpec('app_a', 'app-a-db'));
  assert.deepEqual(same.ok && same.value, { changed: false });
  assert.ok(!f.calls.some((c) => c.method === 'PATCH'));
  const changed = await ensureManagedRole(f.k8s, 'apps-dev', 'apps-pg', appRoleSpec('app_a', 'app-a-db', 5));
  assert.deepEqual(changed.ok && changed.value, { changed: true });
  assert.equal(f.roles().length, 1);
});

test('a concurrent change (409) is re-read and retried, bounded; the role spec never grants superuser or createrole', async () => {
  const f = clusterK8s({ roles: [], conflicts: 2 });
  const r = await ensureManagedRole(f.k8s, 'apps-dev', 'apps-pg', appRoleSpec('app_a', 'app-a-db'));
  assert.ok(r.ok);
  const g = clusterK8s({ roles: [], conflicts: 9 });
  const r2 = await ensureManagedRole(g.k8s, 'apps-dev', 'apps-pg', appRoleSpec('app_a', 'app-a-db'), 3);
  assert.equal(!r2.ok && r2.reason, 'conflict');
  const spec = appRoleSpec('app_a', 'app-a-db');
  assert.equal(spec.superuser, false); assert.equal(spec.createrole, false); assert.equal(spec.createdb, false); assert.equal(spec.replication, false); assert.equal(spec.bypassrls, false);
  assert.equal(spec.login, true);
});

test('readCluster and roleState read CNPG\'s own status; a missing cluster is not_found', async () => {
  const f = clusterK8s({ roles: [appRoleSpec('app_a', 's'), appRoleSpec('app_b', 't')] });
  const c = await readCluster(f.k8s, 'apps-dev', 'apps-pg');
  assert.deepEqual(c.ok && c.value, { name: 'apps-pg', namespace: 'apps-dev', imageName: 'pg@sha256:x', phase: 'Cluster in healthy state', readyInstances: 1, instances: 1 });
  assert.equal((await roleState(f.k8s, 'apps-dev', 'apps-pg', 'app_a')).ok && (await roleState(f.k8s, 'apps-dev', 'apps-pg', 'app_a') as { value: string }).value, 'reconciled');
  assert.equal((await roleState(f.k8s, 'apps-dev', 'apps-pg', 'app_b') as { value: string }).value, 'pending');
  assert.equal((await roleState(f.k8s, 'apps-dev', 'apps-pg', 'app_c') as { value: string }).value, 'missing');
  const none = await readCluster(f.k8s, 'apps-dev', 'nope');
  assert.equal(!none.ok && none.reason, 'not_found');
});

test('ensureDatabase: create, an identical existing one is fine, one for another owner is a conflict', async () => {
  const m = databaseManifest('apps-dev', 'app-x-db', 'apps-pg', 'app_x', 'app_x');
  assert.deepEqual((m.spec as Record<string, unknown>).databaseReclaimPolicy, 'retain');
  const created: CnpgK8s = async () => ({ status: 201, body: {} });
  assert.deepEqual((await ensureDatabase(created, m)).ok, true);
  const exists = (owner: string): CnpgK8s => async (method) => (method === 'POST' ? { status: 409, body: {} } : { status: 200, body: { spec: { name: 'app_x', owner, cluster: { name: 'apps-pg' } } } });
  const same = await ensureDatabase(exists('app_x'), m);
  assert.deepEqual(same.ok && same.value, { created: false });
  const other = await ensureDatabase(exists('app_y'), m);
  assert.equal(!other.ok && other.reason, 'conflict');
});

test('jobState: Complete / Failed conditions, running, missing; transport failure is unreachable', async () => {
  const job = (conditions: unknown[]): CnpgK8s => async () => ({ status: 200, body: { status: { conditions, startTime: 't0' } } });
  assert.equal(((await jobState(job([{ type: 'Complete', status: 'True' }]), 'n', 'j')) as { value: { phase: string } }).value.phase, 'succeeded');
  const failed = (await jobState(job([{ type: 'Failed', status: 'True', reason: 'BackoffLimitExceeded', message: 'Job has reached the specified backoff limit' }]), 'n', 'j')) as { value: { phase: string; reason: string } };
  assert.deepEqual([failed.value.phase, failed.value.reason], ['failed', 'BackoffLimitExceeded: Job has reached the specified backoff limit']);
  assert.equal(((await jobState(job([]), 'n', 'j')) as { value: { phase: string } }).value.phase, 'running');
  assert.equal(((await jobState(async () => ({ status: 404, body: {} }), 'n', 'j')) as { value: { phase: string } }).value.phase, 'missing');
  const down = await jobState(async () => ({ status: 0, body: {} }), 'n', 'j');
  assert.equal(!down.ok && down.reason, 'unreachable');
});
