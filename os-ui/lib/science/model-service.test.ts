/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  _resetModels,
  upsertModel,
  getModel,
  compilePredictPolicy,
  inCallableScope,
  authorizePredict,
  promoteModel,
  goLive,
  certifyModel,
  nextTier,
} from './model-service.ts';
import {
  proposePlan,
  authorizeAgentStep,
  assertAgentCannotCertify,
  type PlanStep,
} from './agent-control.ts';
import { importModel } from './marketplace.ts';
import type { Actor, Caller, ServiceModel } from './types.ts';

// A tool authorizer stub so the spine is tested without the live OPA chain.
const grantPredict = async () => ({ effect: 'allow' as const, policy: 'opa-allow' as const, reason: 'granted' });
const denyPredict = async () => ({ effect: 'deny' as const, policy: 'opa-deny' as const, reason: 'no grant' });
const approvalPredict = async () => ({
  effect: 'requires_approval' as const,
  policy: 'opa-requires-approval' as const,
  reason: 'held',
});

const builder = (domain: string): Actor => ({ id: 'b', role: 'builder', domains: [domain], isAgent: false });
const admin = (domain: string): Actor => ({ id: 'a', role: 'admin', domains: [domain], isAgent: false });
const agentActor = (domain: string): Actor => ({ id: 'ml-agent', role: 'builder', domains: [domain], isAgent: true });

function personalModel(): ServiceModel {
  return {
    id: 'svc_test', model: 'test_model', name: 'Test', owner: 'sara', domain: 'sales',
    tier: 'Personal', stage: 'Staging', frontDoors: ['rest', 'mcp'],
    versions: [{ version: 'v1', stage: 'Staging', auc: 0.8, certified: false, runId: 'r1' }],
  };
}

// ---------------------------------------------------- policy compiler (tier ladder)

test('compiled policy widens callable scope as the tier rises (no separate publish step)', () => {
  _resetModels();
  const m = upsertModel(personalModel());
  assert.deepEqual(compilePredictPolicy(m).allowedDomains, []); // Personal = owner only
  assert.equal(compilePredictPolicy(m).crossDomain, false);

  m.tier = 'Domain';
  assert.deepEqual(compilePredictPolicy(m).allowedDomains, ['sales']); // Domain reach
  assert.equal(compilePredictPolicy(m).crossDomain, false);

  m.tier = 'Marketplace';
  assert.equal(compilePredictPolicy(m).crossDomain, true); // cross-domain
});

test('inCallableScope honours principal / domain / cross-domain', () => {
  _resetModels();
  const m = upsertModel({ ...personalModel(), tier: 'Domain' });
  const policy = compilePredictPolicy(m);
  assert.ok(inCallableScope(policy, { principal: 'sara', domain: 'x', isAgent: false })); // owner principal
  assert.ok(inCallableScope(policy, { principal: 'p', domain: 'sales', isAgent: true })); // domain member
  assert.ok(!inCallableScope(policy, { principal: 'p', domain: 'marketing', isAgent: false })); // outside
});

// ------------------------------------------------ dual front doors (no REST/MCP drift)

test('REST and MCP evaluate the SAME compiled policy — same decision, different door', async () => {
  _resetModels(); // churn_model seeded at Personal; promote so the Sales domain may call
  promoteModel('churn_model', builder('sales'));
  const rest: Caller = { principal: 'churn-risk-app', domain: 'sales', isAgent: false };
  const mcp: Caller = { principal: 'sales-assistant', domain: 'sales', isAgent: true };
  const a = await authorizePredict('churn_model', rest, grantPredict);
  const b = await authorizePredict('churn_model', mcp, grantPredict);
  assert.equal(a.decision, 'allow');
  assert.equal(b.decision, 'allow');
  assert.equal(a.frontDoor, 'rest');
  assert.equal(b.frontDoor, 'mcp');
  assert.equal(a.policy.tier, b.policy.tier); // identical governance, two doors
});

test('tier scope denies an out-of-domain caller even when OPA grants the predict tool', async () => {
  _resetModels();
  const outsider: Caller = { principal: 'mkt-app', domain: 'marketing', isAgent: false };
  const d = await authorizePredict('churn_model', outsider, grantPredict);
  assert.equal(d.decision, 'deny');
  assert.equal(d.toolPolicy, 'tier-scope-deny'); // tier blocked it, not the tool grant
});

test('certifying to Marketplace widens callable scope to a second domain automatically', async () => {
  _resetModels();
  const outsider: Caller = { principal: 'mkt-app', domain: 'marketing', isAgent: true };
  assert.equal((await authorizePredict('churn_model', outsider, grantPredict)).decision, 'deny');
  promoteModel('churn_model', builder('sales')); // Domain — marketing still out of scope
  assert.equal((await authorizePredict('churn_model', outsider, grantPredict)).decision, 'deny');
  certifyModel('churn_model', admin('sales'), 'read-in-place'); // Marketplace — widens cross-domain
  assert.equal((await authorizePredict('churn_model', outsider, grantPredict)).decision, 'allow');
});

test('predict honours the OPA tool decision (deny / requires_approval) inside scope', async () => {
  _resetModels();
  promoteModel('churn_model', builder('sales')); // Domain — sales-assistant is in scope
  const inDomain: Caller = { principal: 'sales-assistant', domain: 'sales', isAgent: true };
  assert.equal((await authorizePredict('churn_model', inDomain, denyPredict)).decision, 'deny');
  assert.equal((await authorizePredict('churn_model', inDomain, approvalPredict)).decision, 'requires_approval');
});

// ------------------------------------------ lifecycle: human-only certify / go-live / promote

test('promote Personal→Domain needs a Builder; an agent can NEVER self-promote', () => {
  _resetModels();
  upsertModel(personalModel());
  assert.throws(() => promoteModel('test_model', agentActor('sales')), /agent cannot promote/i);
  assert.throws(
    () => promoteModel('test_model', { id: 'u', role: 'user', domains: ['sales'], isAgent: false }),
    /Builder or Admin/i,
  );
  assert.equal(promoteModel('test_model', builder('sales')).tier, 'Domain');
});

test('certify Domain→Marketplace needs an Admin; agent blocked; sets consumption mode', () => {
  _resetModels();
  promoteModel('churn_model', builder('sales')); // Personal → Domain, ready to certify
  assert.throws(() => certifyModel('churn_model', agentActor('sales'), 'fork-allowed'), /agent cannot certify/i);
  assert.throws(() => certifyModel('churn_model', builder('sales'), 'read-in-place'), /Admin/i);
  const m = certifyModel('churn_model', admin('sales'), 'fork-allowed');
  assert.equal(m.tier, 'Marketplace');
  assert.equal(m.consumptionMode, 'fork-allowed');
});

test('go-live flips Staging→Production; agent blocked', () => {
  _resetModels();
  upsertModel(personalModel());
  assert.throws(() => goLive('test_model', agentActor('sales')), /agent cannot approve go-live/i);
  const m = goLive('test_model', builder('sales'));
  assert.equal(m.versions.find((v) => v.version === 'v1')?.stage, 'Production');
});

test('nextTier ladder', () => {
  assert.equal(nextTier('Personal'), 'Domain');
  assert.equal(nextTier('Domain'), 'Marketplace');
  assert.equal(nextTier('Marketplace'), null);
});

// ----------------------------------------------------------- ML agent (two-mode)

test('the agent plan stops at Staging — it never proposes certify / go-live', () => {
  const plan = proposePlan('build a churn model from the sales data');
  assert.ok(plan.steps.every((s) => s.kind !== 'certify'));
  assert.equal(plan.steps[plan.steps.length - 1].key, 'deploy-staging');
});

test('assertAgentCannotCertify throws on a forged certify/governance step', () => {
  const forged: PlanStep = { key: 'x', label: 'certify', kind: 'certify', adapter: 'governance' };
  assert.throws(() => assertAgentCannotCertify(forged), /human Builder\/Admin/i);
});

test('two-mode step governance: in-tab approves writes inline, autonomous bounds them', () => {
  const write: PlanStep = { key: 'features', label: 'register features', kind: 'write', adapter: 'features' };
  const read: PlanStep = { key: 'explore', label: 'explore', kind: 'read', adapter: 'features' };
  const gpu: PlanStep = { key: 'train', label: 'train on GPU', kind: 'gpu-spend', adapter: 'train' };

  assert.equal(authorizeAgentStep(read, { mode: 'in-tab', gpuQuotaRemaining: 0 }).decision, 'allow');
  assert.equal(authorizeAgentStep(write, { mode: 'in-tab', gpuQuotaRemaining: 0 }).decision, 'requires_approval');
  assert.equal(
    authorizeAgentStep(write, { mode: 'autonomous', preset: 'read-propose', gpuQuotaRemaining: 0 }).decision,
    'blocked',
  );
  assert.equal(
    authorizeAgentStep(write, { mode: 'autonomous', preset: 'bounded-writes', gpuQuotaRemaining: 0 }).decision,
    'allow',
  );
  assert.equal(authorizeAgentStep(gpu, { mode: 'autonomous', preset: 'bounded-writes', gpuQuotaRemaining: 0 }).decision, 'blocked');
  assert.equal(authorizeAgentStep(gpu, { mode: 'autonomous', preset: 'bounded-writes', gpuQuotaRemaining: 5 }).decision, 'allow');
});

// ------------------------------------------------ marketplace consumption at certify

test('read-in-place import grants predict without copying the model', () => {
  _resetModels();
  promoteModel('churn_model', builder('sales'));
  certifyModel('churn_model', admin('sales'), 'read-in-place');
  const r = importModel('churn_model', { id: 'mara', domain: 'marketing' });
  assert.equal(r.mode, 'read-in-place');
  assert.equal(getModel('churn_model_marketing'), null); // no fork created
  if (r.mode === 'read-in-place') assert.equal(r.grant.tool, 'predict');
});

test('fork-allowed import drops a governed fork in the consumer domain', () => {
  _resetModels();
  promoteModel('churn_model', builder('sales'));
  certifyModel('churn_model', admin('sales'), 'fork-allowed');
  const r = importModel('churn_model', { id: 'mara', domain: 'marketing' });
  assert.equal(r.mode, 'fork-allowed');
  const fork = getModel('churn_model_marketing');
  assert.ok(fork);
  assert.equal(fork?.domain, 'marketing');
  assert.equal(fork?.tier, 'Domain');
});

test('cannot import a model that is not yet certified to the Marketplace', () => {
  _resetModels(); // churn at Domain, not Marketplace
  assert.throws(() => importModel('churn_model', { id: 'm', domain: 'marketing' }), /not certified/i);
});
