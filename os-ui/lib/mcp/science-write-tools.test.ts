/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@/lib/core/auth';
import { handleRpc, ALL_MCP_TOOLS, type JsonRpcResponse, type ToolError } from './server.ts';
import { ALL_WRITE_TOOLS } from './write-tools.ts';
import { config } from '@/lib/core/config';
import { __resetStore as resetData } from '@/lib/data/store';
import { _resetModels, getModel, trainTrackAdapter, deployAdapter } from '@/lib/science';

/**
 * SCIENCE WRITE SURFACE (Phase D) — MCP parity for the full model journey an external
 * agent can now carry: create_model → train_model (fused launch) → get_model_status.
 * Each tool is a THIN adapter over the SAME governed model-service the tab uses; the
 * tests drive them exactly as an AI client would (over handleRpc), asserting:
 *   • the tools are registered, exampled, creator-floored, and write-classified;
 *   • create_model REFUSES a hallucinated dataset (server-side grounding, honest reason);
 *   • train_model is the FUSED launch (submits training, flips draft→training);
 *   • get_model_status ADVANCES the state machine (fuses the deploy, reaches deployed)
 *     and returns the honest phase/reason/metric shape.
 *
 * The train/deploy adapters are STUBBED (no cluster in unit tests) so the fusion logic
 * is exercised deterministically — the same seam the routes submit through.
 */

const cara: CurrentUser = { id: 'cara', name: 'Cara', domains: ['sales'], role: 'creator' };

async function call(user: CurrentUser, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const res = await handleRpc(user, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  assert.ok(res && 'result' in res, `expected a result for ${name}`);
  return (res as JsonRpcResponse).result as Record<string, unknown>;
}
function payload<T = Record<string, unknown>>(r: Record<string, unknown>): T {
  assert.notEqual(r.isError, true, `expected success, got: ${(r.content as { text: string }[])[0]?.text}`);
  return JSON.parse((r.content as { text: string }[])[0].text) as T;
}
function errorOf(r: Record<string, unknown>): ToolError {
  assert.equal(r.isError, true, 'expected a typed tool error');
  return (r.structuredContent as { error: ToolError }).error;
}

const SCIENCE_WRITE = ['create_model', 'train_model', 'get_model_status'];

function withMl<T>(fn: () => Promise<T>): Promise<T> {
  const prev = config.mlEnabled;
  (config as { mlEnabled: boolean }).mlEnabled = true;
  return fn().finally(() => {
    (config as { mlEnabled: boolean }).mlEnabled = prev;
  });
}

/** Create a real, visible dataset for Cara so create_model's grounding can resolve it. */
async function seedDataset(): Promise<string> {
  const ds = payload<{ id: string }>(await call(cara, 'create_dataset', { name: 'Orders' }));
  return ds.id;
}

test('SCIENCE WRITE registry: the three tools are registered, creator-floored, exampled, write-classified', () => {
  const byName = new Map(ALL_MCP_TOOLS.map((t) => [t.name, t]));
  const writeNames = new Set(ALL_WRITE_TOOLS.map((t) => t.name));
  for (const n of SCIENCE_WRITE) {
    const t = byName.get(n);
    assert.ok(t, `${n} missing from ALL_MCP_TOOLS`);
    assert.equal(t!.minRole, 'creator', `${n} floors at creator`);
    assert.equal(t!.tab, 'science', `${n} lives on the science tab`);
    assert.ok((t!.inputSchema.examples ?? []).length >= 1, `${n} carries ≥1 worked example`);
    assert.ok(t!.description.length > 200, `${n} carries a rich tool-doc`);
    assert.ok(writeNames.has(n), `${n} must be in ALL_WRITE_TOOLS`);
  }
});

test('create_model: 404 (not_found) when ml.enabled is false', async () => {
  const prev = config.mlEnabled;
  (config as { mlEnabled: boolean }).mlEnabled = false;
  try {
    const e = errorOf(await call(cara, 'create_model', { name: 'X', dataset: 'ds_x', target: 'y' }));
    assert.equal(e.code, 'not_found');
  } finally {
    (config as { mlEnabled: boolean }).mlEnabled = prev;
  }
});

test('create_model: REFUSES a hallucinated dataset with an honest reason (grounding gate)', async () => {
  resetData();
  _resetModels();
  await withMl(async () => {
    const e = errorOf(await call(cara, 'create_model', { name: 'Churn risk', dataset: 'ds_nope', target: 'churned' }));
    assert.equal(e.code, 'bad_request', 'a dataset the caller cannot see is a typed bad_request');
    assert.match(e.reason, /cannot see/i, 'the refusal NAMES what was hallucinated');
    assert.equal(getModel('churn_risk'), null, 'nothing is registered on a refusal');
  });
});

test('create_model: registers a draft on a REAL dataset + returns the next step', async () => {
  resetData();
  _resetModels();
  await withMl(async () => {
    const dsId = await seedDataset();
    const out = payload<{ ok: boolean; model: { model: string; buildState: string; tier: string }; nextStep: string }>(
      await call(cara, 'create_model', { name: 'Churn risk', dataset: dsId, target: 'churned', features: ['recency_days'] }),
    );
    assert.equal(out.ok, true);
    assert.equal(out.model.buildState, 'draft');
    assert.equal(out.model.tier, 'Personal');
    assert.match(out.nextStep, /train_model/, 'points at the fused launch as the next step');
    assert.ok(getModel(out.model.model), 'the model is really in the registry');
  });
});

test('train_model: the FUSED launch submits training and flips draft→training', async () => {
  resetData();
  _resetModels();
  const prevSubmit = trainTrackAdapter.submit;
  trainTrackAdapter.submit = async (model: string) => ({ model, jobName: `train-${model}`, namespace: 'sci', storageUri: 's3://m' });
  try {
    await withMl(async () => {
      const dsId = await seedDataset();
      const created = payload<{ model: { model: string } }>(
        await call(cara, 'create_model', { name: 'Churn risk', dataset: dsId, target: 'churned' }),
      );
      const model = created.model.model;
      const launched = payload<{ ok: boolean; run: { jobName: string }; launch: { phase: string }; nextStep: string }>(
        await call(cara, 'train_model', { model }),
      );
      assert.equal(launched.ok, true);
      assert.equal(launched.run.jobName, `train-${model}`, 'the real run handle is returned');
      assert.equal(launched.launch.phase, 'training', 'the launch status reflects the fused flow');
      assert.match(launched.nextStep, /get_model_status/, 'points at the poll as the next step');
      assert.equal(getModel(model)?.buildState, 'training', 'the model is now training');
    });
  } finally {
    trainTrackAdapter.submit = prevSubmit;
  }
});

test('get_model_status: ADVANCES the machine — succeeded training fuses the deploy and reaches deployed', async () => {
  resetData();
  _resetModels();
  const prevTrainSubmit = trainTrackAdapter.submit;
  const prevTrainPoll = trainTrackAdapter.poll;
  const prevDeploySubmit = deployAdapter.submit;
  const prevDeployPoll = deployAdapter.poll;
  trainTrackAdapter.submit = async (model: string) => ({ model, jobName: `train-${model}`, namespace: 'sci', storageUri: 's3://m' });
  trainTrackAdapter.poll = async (jobName: string) => ({ jobName, phase: 'succeeded', active: false, reason: 'done' });
  deployAdapter.submit = async (model: string) => ({ isvc: model, storageUri: `s3://models/${model}` });
  deployAdapter.poll = async (model: string) => ({ isvc: model, phase: 'ready', reason: 'Ready' });
  try {
    await withMl(async () => {
      const dsId = await seedDataset();
      const created = payload<{ model: { model: string } }>(
        await call(cara, 'create_model', { name: 'Churn risk', dataset: dsId, target: 'churned' }),
      );
      const model = created.model.model;
      await call(cara, 'train_model', { model });

      // First poll: training succeeded → fuse the deploy (training→deploying).
      const s1 = payload<{ phase: string; reason: string; launch: { launched: boolean } }>(
        await call(cara, 'get_model_status', { model }),
      );
      assert.equal(s1.phase, 'deploying', 'the succeeded run auto-fused the deploy');
      assert.ok(typeof s1.reason === 'string' && s1.reason.length > 0, 'a plain-language reason is present');

      // Second poll: the deploy is ready → deployed (live).
      const s2 = payload<{ phase: string; launch: { launched: boolean }; metric: unknown }>(
        await call(cara, 'get_model_status', { model }),
      );
      assert.equal(s2.phase, 'deployed', 'the deploy poll advanced the model live');
      assert.equal(s2.launch.launched, true, 'the fused launch reached its terminal success');
      // No MLflow in tests → an honest untracked metric object (never fabricated).
      assert.ok('metric' in s2, 'the status carries the metric field');
    });
  } finally {
    trainTrackAdapter.submit = prevTrainSubmit;
    trainTrackAdapter.poll = prevTrainPoll;
    deployAdapter.submit = prevDeploySubmit;
    deployAdapter.poll = prevDeployPoll;
  }
});
