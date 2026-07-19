/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { servePredict } from './serve.ts';
import { _resetModels, upsertModel, churnSeedModel, createModel, type Actor } from './model-service.ts';

/**
 * The GENERIC predict door: `model` selects any registered model (churn stays the
 * back-compat default), a non-deployed model is an honest 409, a deployed model
 * whose endpoint does not answer is an honest 502, and a live v2 endpoint scores.
 */

const sara: Actor = { id: 'sara', role: 'user', domains: ['sales'], isAgent: false };

const spec = () => ({
  sourceDataProductFqn: 'sales.customer_360',
  targetColumn: 'churned',
  taskType: 'binary_classification' as const,
  algorithm: 'logistic',
  features: ['recency_days', 'tenure_months'],
  trainTestSplit: 0.8,
  optimizeMetric: 'auc',
});

/** Fake fetch: answers the model's own predictor with a v2 infer body; 200 {} elsewhere. */
function fakeFetch(opts: { predictorScore?: number; predictorDown?: boolean }) {
  const orig = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    seen.push(url);
    if (url.includes('-predictor:80/v2/models/')) {
      if (opts.predictorDown) throw new Error('ECONNREFUSED');
      return new Response(JSON.stringify({ outputs: [{ data: [opts.predictorScore ?? 0.7] }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    // Langfuse / OPA / KServe-churn etc: benign generic answer (trace is best-effort;
    // the churn KServe probe failing routes to the deterministic offline seed).
    return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { seen, restore: () => { globalThis.fetch = orig; } };
}

test('back-compat: no `model` arg scores the churn slice (offline seed) for a granted principal', async () => {
  const f = fakeFetch({});
  try {
    _resetModels();
    upsertModel(churnSeedModel()); // Domain(sales) seed
    const r = await servePredict({
      account: 'acme',
      principal: 'sales-assistant', // LOCAL_GRANTS carries predict (OPA offline mirror)
      domains: ['sales'],
      isAgent: true,
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.model, 'churn_model');
    assert.equal(r.body.decision, 'allow');
    assert.equal(r.body.source, 'seed-offline'); // KServe absent → deterministic seed, honestly labeled
    assert.ok(typeof r.body.score === 'number');
    assert.ok(r.body.band);
  } finally {
    f.restore();
    _resetModels();
  }
});

test('generic model param: a model that is NOT deployed is an honest 409, never a fake score', async () => {
  const f = fakeFetch({});
  try {
    _resetModels();
    createModel({ name: 'Lead scoring', spec: spec() }, sara); // draft
    const r = await servePredict({
      model: 'lead_scoring',
      principal: 'user:sara', // the OWNER (session form) — in scope, no grant needed
      domains: ['sales'],
      isAgent: false,
    });
    assert.equal(r.status, 409);
    assert.match(String(r.body.error), /not deployed/i);
  } finally {
    f.restore();
    _resetModels();
  }
});

test('generic model param: a DEPLOYED model scores against its OWN per-model endpoint (spec-ordered vector)', async () => {
  const f = fakeFetch({ predictorScore: 0.42 });
  try {
    _resetModels();
    const m = createModel({ name: 'Lead scoring', spec: spec() }, sara);
    upsertModel({ ...m, buildState: 'deployed', kserveService: 'lead-scoring' });
    const r = await servePredict({
      model: 'lead_scoring',
      principal: 'user:sara',
      domains: ['sales'],
      isAgent: false,
      features: { recency_days: 30, tenure_months: 12 },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.model, 'lead_scoring');
    assert.equal(r.body.score, 0.42);
    assert.equal(r.body.band, 'medium'); // binary classification → banded
    assert.equal(r.body.source, 'kserve');
    // It called the model's OWN predictor Service, not the churn endpoint.
    assert.ok(f.seen.some((u) => u.startsWith('http://lead-scoring-predictor:80/v2/models/lead_scoring/infer')));
  } finally {
    f.restore();
    _resetModels();
  }
});

test('generic model param: a deployed model whose endpoint is DOWN is an honest 502', async () => {
  const f = fakeFetch({ predictorDown: true });
  try {
    _resetModels();
    const m = createModel({ name: 'Lead scoring', spec: spec() }, sara);
    upsertModel({ ...m, buildState: 'deployed', kserveService: 'lead-scoring' });
    const r = await servePredict({
      model: 'lead_scoring',
      principal: 'user:sara',
      domains: ['sales'],
      isAgent: false,
    });
    assert.equal(r.status, 502);
    assert.match(String(r.body.error), /unreachable/i);
  } finally {
    f.restore();
    _resetModels();
  }
});

test('an unknown model is a 403 deny (tier scope fails closed) with the model named', async () => {
  const f = fakeFetch({});
  try {
    _resetModels();
    const r = await servePredict({ model: 'nope', principal: 'user:sara', domains: ['sales'], isAgent: false });
    assert.equal(r.status, 403);
    assert.match(String(r.body.reason), /unknown model nope/);
  } finally {
    f.restore();
    _resetModels();
  }
});
