/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyLiveRegistration, propsToProperties, extSecretName, type RegK8s } from './k8s-registration.ts';
import { catalogRegistration } from './registration.ts';
import type { WarehouseSource } from './types.ts';

/** A recording fake k8s client: logs every call and answers a scripted status. */
function fakeK8s(script: (method: string, path: string) => number = () => 200) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const k8s: RegK8s = async (method, path, body) => {
    calls.push({ method, path, body });
    // GET on the ext secret 404s first time so the code POSTs it.
    if (method === 'GET' && /secrets\/trino-ext-/.test(path)) return { status: 404, body: {} };
    return { status: script(method, path), body: {} };
  };
  return { k8s, calls };
}

const NS = 'agentic-os';

test('propsToProperties serializes sorted key=value lines with a trailing newline', () => {
  const text = propsToProperties({ b: '2', a: '1' });
  assert.equal(text, 'a=1\nb=2\n');
});

test('register (Snowflake): merges ConfigMap key, creates Secret, patches env + rollout', async () => {
  const source: WarehouseSource = {
    catalog: 'snow_fin', platform: 'snowflake',
    accountUrl: 'ACME-PROD', database: 'DB', warehouse: 'WH', username: 'svc',
  } as WarehouseSource;
  const reg = catalogRegistration(source);
  const { k8s, calls } = fakeK8s();
  const out = await applyLiveRegistration(reg, { SNOWFLAKE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----abc-----END PRIVATE KEY-----' }, { namespace: NS, k8s });

  assert.equal(out.ok, true);
  assert.equal(out.live, true);

  // (a) ConfigMap merge carries the catalog .properties under the right key.
  const cmPatch = calls.find((c) => c.method === 'PATCH' && c.path.endsWith('/configmaps/trino-catalog'));
  assert.ok(cmPatch, 'patched the trino-catalog ConfigMap');
  const cmData = (cmPatch!.body as { data: Record<string, string> }).data;
  assert.ok('snow_fin.properties' in cmData, 'merged snow_fin.properties key');
  assert.match(cmData['snow_fin.properties'], /connector\.name=snowflake/);
  // The secret VALUE never leaks into the catalog props.
  assert.ok(!/BEGIN PRIVATE KEY/.test(cmData['snow_fin.properties']), 'no PEM in props');
  assert.match(cmData['snow_fin.properties'], /connection-private-key=\$\{ENV:SNOWFLAKE_PRIVATE_KEY\}/);

  // (b) Secret created with the env-var key, referencing the PEM value.
  const secretPost = calls.find((c) => c.method === 'POST' && c.path.endsWith('/secrets'));
  assert.ok(secretPost, 'created the trino-ext-snow-fin Secret');
  const sd = (secretPost!.body as { stringData: Record<string, string>; metadata: { name: string } });
  assert.equal(sd.metadata.name, extSecretName('snow_fin'));
  assert.ok('SNOWFLAKE_PRIVATE_KEY' in sd.stringData, 'secret key = the env var');

  // (b) Deployment env patch wires the secretKeyRef.
  const envPatch = calls.find(
    (c) => c.method === 'PATCH' && c.path.endsWith('/deployments/trino') &&
      JSON.stringify(c.body).includes('secretKeyRef'),
  );
  assert.ok(envPatch, 'patched Trino env with a secretKeyRef');

  // (c) Rollout: a pod-template annotation patch on the Deployment.
  const rollout = calls.find(
    (c) => c.method === 'PATCH' && c.path.endsWith('/deployments/trino') &&
      JSON.stringify(c.body).includes('catalog-registered'),
  );
  assert.ok(rollout, 'rolled the Trino Deployment via a template annotation');
});

test('register (Glue): keyless IRSA emits NO secret and NO env patch — only ConfigMap + rollout', async () => {
  const source: WarehouseSource = { catalog: 'glue_sales', platform: 'glue', region: 'eu-central-1' };
  const reg = catalogRegistration(source);
  const { k8s, calls } = fakeK8s();
  const out = await applyLiveRegistration(reg, {}, { namespace: NS, k8s });

  assert.equal(out.ok, true);
  assert.deepEqual(out.steps.secret.keys, [], 'no secret keys for keyless Glue');

  // No Secret is ever created.
  assert.ok(!calls.some((c) => /\/secrets/.test(c.path)), 'no secret API calls at all');
  // No env-wiring patch (only the ConfigMap merge + the rollout annotation patch).
  assert.ok(!calls.some((c) => JSON.stringify(c.body ?? {}).includes('secretKeyRef')), 'no env secretKeyRef patch');

  const cmPatch = calls.find((c) => c.path.endsWith('/configmaps/trino-catalog'));
  const cmData = (cmPatch!.body as { data: Record<string, string> }).data;
  assert.match(cmData['glue_sales.properties'], /connector\.name=iceberg/);
  assert.ok(calls.some((c) => JSON.stringify(c.body ?? {}).includes('catalog-registered')), 'rolled Trino');
});

test('register: an API rejection on the ConfigMap short-circuits BEFORE any rollout (honest)', async () => {
  const source: WarehouseSource = { catalog: 'glue_sales', platform: 'glue', region: 'eu-central-1' };
  const reg = catalogRegistration(source);
  // ConfigMap PATCH is rejected 403.
  const { k8s, calls } = fakeK8s((method, path) => (path.endsWith('/configmaps/trino-catalog') ? 403 : 200));
  const out = await applyLiveRegistration(reg, {}, { namespace: NS, k8s });

  assert.equal(out.ok, false);
  assert.equal(out.steps.configMap.status, 403);
  assert.match(out.detail, /rejected the ConfigMap/i);
  // No rollout annotation was ever attempted.
  assert.ok(!calls.some((c) => JSON.stringify(c.body ?? {}).includes('catalog-registered')), 'no rollout on failure');
});

test('register: not-in-cluster (status 0) is reported honestly as not-live', async () => {
  const source: WarehouseSource = { catalog: 'glue_sales', platform: 'glue', region: 'eu-central-1' };
  const reg = catalogRegistration(source);
  const k8s: RegK8s = async () => ({ status: 0, body: {} });
  const out = await applyLiveRegistration(reg, {}, { namespace: NS, k8s });
  assert.equal(out.ok, false);
  assert.equal(out.live, false);
  assert.match(out.detail, /Kubernetes API/i);
});
