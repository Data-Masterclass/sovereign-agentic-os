/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isvcName,
  isvcServiceUrl,
  buildInferenceService,
  submitDeploy,
  deployPhase,
  readDeploy,
  type DeployRuntime,
} from './deploy.ts';
import type { K8sClient } from './training.ts';

const RT: DeployRuntime = { namespace: 'agentic-os', serviceAccountName: 'kserve-sa' };

// ---------------------------------------------------------------- naming -------

test('isvcName is DNS-1123-safe (underscores → hyphens); service URL targets the predictor', () => {
  assert.equal(isvcName('lead_scoring'), 'lead-scoring');
  assert.equal(isvcName('Churn_Model!!'), 'churn-model');
  assert.equal(isvcServiceUrl('lead_scoring'), 'http://lead-scoring-predictor:80');
});

// ---------------------------------------------------------------- manifest -----

test('buildInferenceService mirrors the chart shape (RawDeployment, v2, mlserver_sklearn, storageUri)', () => {
  const isvc = buildInferenceService('lead_scoring', RT) as any;
  assert.equal(isvc.apiVersion, 'serving.kserve.io/v1beta1');
  assert.equal(isvc.kind, 'InferenceService');
  assert.equal(isvc.metadata.name, 'lead-scoring'); // DNS-safe, never the raw underscore id
  assert.equal(isvc.metadata.namespace, 'agentic-os');
  assert.equal(isvc.metadata.labels.modelClass, 'mlserver_sklearn.SKLearnModel');
  assert.equal(isvc.metadata.labels['sovereign-os/model'], 'lead_scoring');
  assert.equal(isvc.metadata.annotations['serving.kserve.io/deploymentMode'], 'RawDeployment');
  const model = isvc.spec.predictor.model;
  assert.equal(isvc.spec.predictor.serviceAccountName, 'kserve-sa');
  assert.equal(model.protocolVersion, 'v2');
  assert.equal(model.modelFormat.name, 'sklearn');
  // Serves EXACTLY where the training runtime uploaded the artifact.
  assert.equal(model.storageUri, 's3://mlflow/models/lead_scoring');
  assert.ok(model.resources.limits.cpu, 'CPU-bounded by construction');
});

// ---------------------------------------------------------------- submit -------

test('submitDeploy POSTs a new InferenceService when absent (GET 404 → POST)', async () => {
  const calls: { method: string; path: string }[] = [];
  const fake: K8sClient = async (method, path) => {
    calls.push({ method, path });
    if (method === 'GET') return { status: 404, body: {} };
    return { status: 201, body: {} };
  };
  const r = await submitDeploy('lead_scoring', RT, fake);
  assert.deepEqual(calls.map((c) => c.method), ['GET', 'POST']);
  assert.match(calls[1].path, /\/namespaces\/agentic-os\/inferenceservices$/);
  assert.equal(r.isvc, 'lead-scoring');
  assert.equal(r.storageUri, 's3://mlflow/models/lead_scoring');
});

test('submitDeploy reconciles an EXISTING InferenceService (GET 200 → PUT with resourceVersion)', async () => {
  const bodies: unknown[] = [];
  const fake: K8sClient = async (method, path, body) => {
    if (method === 'GET') return { status: 200, body: { metadata: { resourceVersion: '42' } } };
    bodies.push(body);
    assert.equal(method, 'PUT');
    assert.match(path, /\/inferenceservices\/lead-scoring$/);
    return { status: 200, body: {} };
  };
  await submitDeploy('lead_scoring', RT, fake);
  const manifest = bodies[0] as { metadata: { resourceVersion?: string } };
  assert.equal(manifest.metadata.resourceVersion, '42', 'idempotent replace carries the live resourceVersion');
});

test('submitDeploy is HONEST offline: an unreachable cluster is a typed 503, never a fake deploy', async () => {
  const fake: K8sClient = async () => ({ status: 0, body: {} });
  await assert.rejects(() => submitDeploy('m', RT, fake), (e: any) => e.status === 503);
});

test('submitDeploy surfaces a Kubernetes rejection as a typed error with the API message', async () => {
  const fake: K8sClient = async (method) =>
    method === 'GET' ? { status: 404, body: {} } : { status: 422, body: { message: 'invalid spec' } };
  await assert.rejects(() => submitDeploy('m', RT, fake), /invalid spec/);
});

// ---------------------------------------------------------------- status -------

test('deployPhase maps the ISVC status onto ready / failed / progressing', () => {
  assert.equal(deployPhase(undefined).phase, 'progressing');
  assert.equal(deployPhase({ conditions: [{ type: 'Ready', status: 'True' }] }).phase, 'ready');
  assert.equal(
    deployPhase({ conditions: [{ type: 'Ready', status: 'False' }] }).phase,
    'progressing',
    'not-yet-ready is still rolling out, not failed',
  );
  const failed = deployPhase({
    conditions: [{ type: 'Ready', status: 'False' }],
    modelStatus: { transitionStatus: 'BlockedByFailedLoad', lastFailureInfo: { message: 'No model found' } },
  });
  assert.equal(failed.phase, 'failed');
  assert.match(failed.reason, /No model found/);
});

test('readDeploy: unreachable → unknown (keep polling); missing ISVC → failed (honest)', async () => {
  const offline: K8sClient = async () => ({ status: 0, body: {} });
  assert.equal((await readDeploy('m', RT, offline)).phase, 'unknown');
  const gone: K8sClient = async () => ({ status: 404, body: {} });
  assert.equal((await readDeploy('m', RT, gone)).phase, 'failed');
  const ready: K8sClient = async () => ({ status: 200, body: { status: { conditions: [{ type: 'Ready', status: 'True' }] } } });
  assert.equal((await readDeploy('m', RT, ready)).phase, 'ready');
});
