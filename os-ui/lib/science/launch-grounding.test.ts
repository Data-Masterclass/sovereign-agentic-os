/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * The Science LAUNCH-stage GROUNDING — `collectLaunchGrounding` gathers the REAL launch signals
 * for a model (captured train/publish error + training run log tail + live KServe status), and
 * `renderLaunchGrounding` renders them into the bounded, honest block the assistant is grounded in.
 * We stub config/k8s/adapters/deploy so the collector is exercised deterministically off-cluster.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// The heavy value deps launch-grounding imports at module load — neutralised for the unit test.
mock.module('@/lib/core/config', {
  namedExports: { config: { mlEnabled: true, platformNamespace: 'agentic-os' } },
});
mock.module('@/lib/infra/k8s', {
  namedExports: {
    k8s: async () => ({ status: 200, body: { items: [{ metadata: { name: 'train-x-pod' } }] } }),
    k8sText: async () => ({ status: 200, text: 'reading gold via Trino…\nTraceback: ValueError: target column "churned" not found\n' }),
  },
});
mock.module('@/lib/science/adapters', {
  namedExports: { deployRuntime: () => ({ namespace: 'agentic-os', serviceAccountName: 'kserve-sa' }) },
});

const model: any = {
  id: 'svc_x',
  model: 'x',
  name: 'X',
  owner: 'u1',
  domain: 'acme',
  tier: 'Personal',
  buildState: 'draft',
  lastTrainingError: 'training job failed',
  trainingJob: 'train-x',
  trainingNamespace: 'agentic-os',
  versions: [],
};

const { collectLaunchGrounding, renderLaunchGrounding, LAUNCH_LOG_TAIL_LINES } = await import('./launch-grounding.ts');

test('collectLaunchGrounding surfaces the captured error + the real training log tail', async () => {
  const g = await collectLaunchGrounding(model);
  assert.equal(g.trainingError, 'training job failed');
  assert.match(g.trainingLog, /Traceback: ValueError: target column "churned" not found/);
  assert.equal(g.servingRuntimeMisconfigured, false);
});

test('renderLaunchGrounding includes the real error + log lines and never fabricates', async () => {
  const g = await collectLaunchGrounding(model);
  const block = renderLaunchGrounding(g);
  assert.match(block, /Captured training error: training job failed/);
  assert.match(block, /line\(s\) of the training run log/);
  assert.match(block, /Traceback: ValueError/);
});

test('renderLaunchGrounding flags a serving-runtime misconfiguration as an ADMIN fix', () => {
  const block = renderLaunchGrounding({
    deployError: 'exec: "--model_name=x": executable file not found in $PATH',
    trainingLog: '',
    servingRuntimeMisconfigured: true,
  });
  assert.match(block, /CLUSTER serving-runtime misconfiguration/);
  assert.match(block, /admin fix/i);
  assert.match(block, /SCIENCE-KSERVE-FIX\.md/);
});

test('renderLaunchGrounding is honest when there are no signals yet', () => {
  const block = renderLaunchGrounding({ trainingLog: '', servingRuntimeMisconfigured: false });
  assert.match(block, /no captured error or logs/);
});

test('LAUNCH_LOG_TAIL_LINES is a sane bound (20-40 lines)', () => {
  assert.ok(LAUNCH_LOG_TAIL_LINES >= 20 && LAUNCH_LOG_TAIL_LINES <= 40);
});
