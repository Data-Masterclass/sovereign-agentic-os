/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTrainingJob,
  isTrainableTask,
  resolveAlgorithm,
  trainingJobName,
  modelStorageUri,
  jobPhase,
  submitTrainingJob,
  readTrainingJob,
  type K8sClient,
  type TrainingRuntime,
} from './training.ts';
import type { ModelSpec } from './types.ts';

const RT: TrainingRuntime = {
  namespace: 'agentic-os',
  trainerImage: 'sovereign-os/ml-trainer:0.1.0',
  awsCliImage: 'amazon/aws-cli:2.31.13',
  s3Endpoint: 'http://minio:9000',
  s3SecretName: 'object-storage-credentials',
  s3Region: 'us-east-1',
  trinoHost: 'trino',
  trinoPort: 8080,
  trinoUser: 'science-reader',
  trinoCatalog: 'iceberg',
  mlflowUrl: 'http://mlflow:5000',
};

function spec(over: Partial<ModelSpec> = {}): ModelSpec {
  return {
    sourceDataProductFqn: 'sales.customer_360',
    targetColumn: 'churned',
    taskType: 'binary_classification',
    algorithm: 'logistic',
    features: ['recency_days', 'order_frequency', 'monetary_value'],
    trainTestSplit: 0.8,
    optimizeMetric: 'auc',
    ...over,
  };
}

// -------------------------------------------------------- honest algorithm set ---

test('isTrainableTask accepts classification + regression, rejects forecast/clustering', () => {
  assert.equal(isTrainableTask('binary_classification'), true);
  assert.equal(isTrainableTask('regression'), true);
  assert.equal(isTrainableTask('forecast'), false);
  assert.equal(isTrainableTask('clustering'), false);
});

test('resolveAlgorithm maps xgboost/unknown onto the honest sklearn learner', () => {
  assert.equal(resolveAlgorithm(spec({ algorithm: 'xgboost' })), 'logistic');
  assert.equal(resolveAlgorithm(spec({ algorithm: 'random_forest' })), 'random_forest');
  assert.equal(resolveAlgorithm(spec({ algorithm: 'nonsense' })), 'logistic');
  assert.equal(resolveAlgorithm(spec({ taskType: 'regression', algorithm: 'rf' })), 'random_forest');
  assert.equal(resolveAlgorithm(spec({ taskType: 'regression', algorithm: 'auto' })), 'linear');
});

test('storageUri + job name are deterministic and DNS-safe', () => {
  assert.equal(modelStorageUri('lead_scoring'), 's3://mlflow/models/lead_scoring');
  const name = trainingJobName('Lead_Scoring!!', 100);
  assert.match(name, /^train-lead-scoring-[a-z0-9]+$/);
});

// --------------------------------------------------------------- job manifest ---

test('buildTrainingJob renders a batch/v1 Job with spec-derived env and no inlined secret', () => {
  const job = buildTrainingJob('lead_scoring', spec(), RT, 'train-lead-scoring-abc') as any;
  assert.equal(job.apiVersion, 'batch/v1');
  assert.equal(job.kind, 'Job');
  assert.equal(job.metadata.name, 'train-lead-scoring-abc');
  assert.equal(job.metadata.namespace, 'agentic-os');
  assert.equal(job.metadata.labels['sovereign-os/model'], 'lead_scoring');

  const train = job.spec.template.spec.initContainers[0];
  assert.equal(train.image, 'sovereign-os/ml-trainer:0.1.0');
  const env = Object.fromEntries(train.env.map((e: any) => [e.name, e.value]));
  // Spec-derived params flow into the trainer as plain env.
  assert.equal(env.MODEL_NAME, 'lead_scoring');
  assert.equal(env.SOURCE_FQN, 'sales.customer_360');
  assert.equal(env.TARGET_COLUMN, 'churned');
  assert.equal(env.FEATURES, 'recency_days,order_frequency,monetary_value');
  assert.equal(env.TASK_TYPE, 'binary_classification');
  // The governed READ path — least-privilege Trino principal, never a write role.
  assert.equal(env.TRINO_USER, 'science-reader');
  assert.equal(env.TRINO_HOST, 'trino');

  // AWS creds are pulled from the Secret by the upload container — NEVER inlined.
  const upload = job.spec.template.spec.containers[0];
  const secretEnv = upload.env.find((e: any) => e.name === 'AWS_ACCESS_KEY_ID');
  assert.ok(secretEnv.valueFrom.secretKeyRef, 'AWS key must come from secretKeyRef');
  assert.equal(secretEnv.valueFrom.secretKeyRef.name, 'object-storage-credentials');
  assert.equal(secretEnv.value, undefined, 'no raw secret value may be inlined');
  // The whole manifest must not contain a literal secret string.
  assert.doesNotMatch(JSON.stringify(job), /agentic-os-local-secret|AKIA|password/i);
  // Upload targets the exact KServe storageUri.
  const storageEnv = Object.fromEntries(upload.env.map((e: any) => [e.name, e.value]));
  assert.equal(storageEnv.STORAGE_URI, 's3://mlflow/models/lead_scoring');
});

// --------------------------------------------------------- submit + poll (fake) ---

test('submitTrainingJob POSTs the Job to the batch API and returns a run handle', async () => {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const fake: K8sClient = async (method, path, body) => {
    calls.push({ method, path, body });
    return { status: 201, body: {} };
  };
  const run = await submitTrainingJob('lead_scoring', spec(), RT, fake);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].path, '/apis/batch/v1/namespaces/agentic-os/jobs');
  assert.equal(run.model, 'lead_scoring');
  assert.equal(run.namespace, 'agentic-os');
  assert.equal(run.storageUri, 's3://mlflow/models/lead_scoring');
  assert.match(run.jobName, /^train-lead-scoring-/);
});

test('submitTrainingJob rejects an untrainable task before touching the cluster', async () => {
  let called = false;
  const fake: K8sClient = async () => { called = true; return { status: 201, body: {} }; };
  await assert.rejects(
    () => submitTrainingJob('m', spec({ taskType: 'forecast' }), RT, fake),
    /cannot train a forecast/,
  );
  assert.equal(called, false, 'no Job may be created for an unsupported task');
});

test('submitTrainingJob surfaces an unreachable cluster (status 0) as 503', async () => {
  const fake: K8sClient = async () => ({ status: 0, body: {} });
  await assert.rejects(
    () => submitTrainingJob('m', spec(), RT, fake),
    (e: any) => e.status === 503,
  );
});

test('jobPhase maps k8s Job status onto the coarse phase', () => {
  assert.equal(jobPhase(undefined), 'unknown');
  assert.equal(jobPhase({ active: 1 }), 'running');
  assert.equal(jobPhase({ succeeded: 1 }), 'succeeded');
  assert.equal(jobPhase({ failed: 1 }), 'failed');
  assert.equal(jobPhase({}), 'pending');
});

test('readTrainingJob reports succeeded when the Job completes', async () => {
  const fake: K8sClient = async (method, path) => {
    assert.equal(method, 'GET');
    assert.match(path, /\/jobs\/train-lead-scoring-abc$/);
    return { status: 200, body: { status: { succeeded: 1 } } };
  };
  const s = await readTrainingJob('train-lead-scoring-abc', 'agentic-os', fake);
  assert.equal(s.phase, 'succeeded');
  assert.equal(s.active, false);
});

test('readTrainingJob degrades to unknown when the cluster is unreachable', async () => {
  const fake: K8sClient = async () => ({ status: 0, body: {} });
  const s = await readTrainingJob('j', 'ns', fake);
  assert.equal(s.phase, 'unknown');
});
