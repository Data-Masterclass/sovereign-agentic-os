/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  _resetModels,
  upsertModel,
  getModel,
  listModels,
  listModelsForUser,
  compilePredictPolicy,
  inCallableScope,
  authorizePredict,
  promoteModel,
  goLive,
  certifyModel,
  nextTier,
  setModelArchived,
  deleteModel,
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

// The store ships EMPTY now; tests that exercise the churn worked-example
// register it themselves (Personal tier, Production stage) right after reset.
function churnModel(): ServiceModel {
  return {
    id: 'svc_churn_model', model: 'churn_model', name: 'Churn model', owner: 'sara', domain: 'sales',
    tier: 'Personal', stage: 'Production', frontDoors: ['rest', 'mcp'],
    versions: [{ version: 'v2', stage: 'Production', auc: 0.871, certified: true, runId: 'mlf-run-2a9c' }],
  };
}
function resetWithChurn(): void {
  _resetModels();
  upsertModel(churnModel());
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
  assert.ok(inCallableScope(policy, { principal: 'sara', domains: ['x'], isAgent: false })); // owner principal
  assert.ok(inCallableScope(policy, { principal: 'p', domains: ['sales'], isAgent: true })); // domain member
  assert.ok(!inCallableScope(policy, { principal: 'p', domains: ['marketing'], isAgent: false })); // outside
});

// ------------------------------------------------ RLS: listModelsForUser entitlement boundary

test('listModelsForUser is RLS-scoped — no other-domain or other-user Personal leak', () => {
  _resetModels();
  const m = (over: Partial<ServiceModel>): ServiceModel => ({ ...personalModel(), ...over });
  upsertModel(m({ id: 'svc_p', model: 'p_model', name: 'A Personal sales', owner: 'sara', domain: 'sales', tier: 'Personal' }));
  upsertModel(m({ id: 'svc_d', model: 'd_model', name: 'B Domain sales', owner: 'sara', domain: 'sales', tier: 'Domain' }));
  upsertModel(m({ id: 'svc_dm', model: 'dm_model', name: 'C Domain marketing', owner: 'mara', domain: 'marketing', tier: 'Domain' }));
  upsertModel(m({ id: 'svc_mp', model: 'mp_model', name: 'D Marketplace', owner: 'sara', domain: 'sales', tier: 'Marketplace' }));

  // Owner in sales: own Personal + sales Domain + Marketplace; NOT marketing's Domain model.
  assert.deepEqual(
    new Set(listModelsForUser({ id: 'sara', domains: ['sales'] }).map((x) => x.model)),
    new Set(['p_model', 'd_model', 'mp_model']),
  );
  // A different sales user: sales Domain + Marketplace, but NOT sara's Personal model.
  assert.deepEqual(
    new Set(listModelsForUser({ id: 'bob', domains: ['sales'] }).map((x) => x.model)),
    new Set(['d_model', 'mp_model']),
  );
  // A marketing user: only marketing's Domain + Marketplace — no sales Personal/Domain leak.
  assert.deepEqual(
    new Set(listModelsForUser({ id: 'mara', domains: ['marketing'] }).map((x) => x.model)),
    new Set(['dm_model', 'mp_model']),
  );
  // The unscoped variant still returns the whole registry (system/aggregate use only).
  assert.equal(listModels().length, 4);
});

// ------------------------------------------------ dual front doors (no REST/MCP drift)

test('REST and MCP evaluate the SAME compiled policy — same decision, different door', async () => {
  resetWithChurn(); // churn_model registered at Personal; promote so the Sales domain may call
  promoteModel('churn_model', builder('sales'));
  const rest: Caller = { principal: 'churn-risk-app', domains: ['sales'], isAgent: false };
  const mcp: Caller = { principal: 'sales-assistant', domains: ['sales'], isAgent: true };
  const a = await authorizePredict('churn_model', rest, grantPredict);
  const b = await authorizePredict('churn_model', mcp, grantPredict);
  assert.equal(a.decision, 'allow');
  assert.equal(b.decision, 'allow');
  assert.equal(a.frontDoor, 'rest');
  assert.equal(b.frontDoor, 'mcp');
  assert.equal(a.policy.tier, b.policy.tier); // identical governance, two doors
});

test('tier scope denies an out-of-domain caller even when OPA grants the predict tool', async () => {
  resetWithChurn();
  const outsider: Caller = { principal: 'mkt-app', domains: ['marketing'], isAgent: false };
  const d = await authorizePredict('churn_model', outsider, grantPredict);
  assert.equal(d.decision, 'deny');
  assert.equal(d.toolPolicy, 'tier-scope-deny'); // tier blocked it, not the tool grant
});

test('SECURITY: tier scope uses SESSION domains — a marketing caller cannot reach a Sales model even with a granted principal; multi-domain membership is honored', async () => {
  resetWithChurn();
  promoteModel('churn_model', builder('sales')); // Domain(sales)
  // Even carrying the granted `sales-assistant` principal, a caller whose SESSION
  // domains are ['marketing'] is denied by tier scope — no body-forged domain helps.
  const outsider: Caller = { principal: 'sales-assistant', domains: ['marketing'], isAgent: true };
  const d = await authorizePredict('churn_model', outsider, grantPredict);
  assert.equal(d.decision, 'deny');
  assert.equal(d.toolPolicy, 'tier-scope-deny');
  // A user who belongs to BOTH marketing and sales is in scope (any-domain match).
  const dual: Caller = { principal: 'sales-assistant', domains: ['marketing', 'sales'], isAgent: true };
  assert.equal((await authorizePredict('churn_model', dual, grantPredict)).decision, 'allow');
});

test('certifying to Marketplace widens callable scope to a second domain automatically', async () => {
  resetWithChurn();
  const outsider: Caller = { principal: 'mkt-app', domains: ['marketing'], isAgent: true };
  assert.equal((await authorizePredict('churn_model', outsider, grantPredict)).decision, 'deny');
  promoteModel('churn_model', builder('sales')); // Domain — marketing still out of scope
  assert.equal((await authorizePredict('churn_model', outsider, grantPredict)).decision, 'deny');
  certifyModel('churn_model', admin('sales'), 'read-in-place'); // Marketplace — widens cross-domain
  assert.equal((await authorizePredict('churn_model', outsider, grantPredict)).decision, 'allow');
});

test('predict honours the OPA tool decision (deny / requires_approval) inside scope', async () => {
  resetWithChurn();
  promoteModel('churn_model', builder('sales')); // Domain — sales-assistant is in scope
  const inDomain: Caller = { principal: 'sales-assistant', domains: ['sales'], isAgent: true };
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
    /Builder|Domain admin|Admin/i,
  );
  assert.equal(promoteModel('test_model', builder('sales')).tier, 'Domain');
});

test('certify Domain→Marketplace needs an Admin; agent blocked; sets consumption mode', () => {
  resetWithChurn();
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
  resetWithChurn();
  promoteModel('churn_model', builder('sales'));
  certifyModel('churn_model', admin('sales'), 'read-in-place');
  const r = importModel('churn_model', { id: 'mara', domain: 'marketing' });
  assert.equal(r.mode, 'read-in-place');
  assert.equal(getModel('churn_model_marketing'), null); // no fork created
  if (r.mode === 'read-in-place') assert.equal(r.grant.tool, 'predict');
});

test('fork-allowed import drops a governed fork in the consumer domain', () => {
  resetWithChurn();
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
  resetWithChurn(); // churn at Personal, not Marketplace
  assert.throws(() => importModel('churn_model', { id: 'm', domain: 'marketing' }), /not certified/i);
});

test('setModelArchived archives + restores; archived drops out of the viewer list', () => {
  _resetModels();
  upsertModel(personalModel()); // owner sara, domain sales, model test_model
  const viewer = { id: 'sara', domains: ['sales'] };
  assert.equal(listModelsForUser(viewer).length, 1);
  setModelArchived('test_model', admin('sales'), true);
  assert.equal(listModelsForUser(viewer).length, 0, 'archived model hidden by default');
  assert.equal(listModelsForUser(viewer, { includeArchived: true }).length, 1);
  setModelArchived('test_model', admin('sales'), false);
  assert.equal(listModelsForUser(viewer).length, 1, 'restored model visible again');
});

test('deleteModel requires archive first, then removes the record', () => {
  _resetModels();
  upsertModel(personalModel());
  assert.throws(() => deleteModel('test_model', admin('sales')), /archive the model before deleting/i);
  setModelArchived('test_model', admin('sales'), true);
  deleteModel('test_model', admin('sales'));
  assert.equal(getModel('test_model'), null, 'record physically removed');
});

test('archive/delete reject agents and out-of-domain / non-owner non-admin actors', () => {
  _resetModels();
  upsertModel(personalModel()); // owner sara, domain sales
  assert.throws(() => setModelArchived('test_model', agentActor('sales'), true), /agent cannot/i);
  assert.throws(() => setModelArchived('test_model', admin('marketing'), true), /domain you belong to/i);
  // a builder who is neither the owner (sara) nor a domain_admin/admin is edit-scoped out
  assert.throws(() => setModelArchived('test_model', builder('sales'), true), /owner|Domain admin|Admin/i);
});

test('archive/delete: a domain_admin of the owning domain MAY manage a non-owned model', () => {
  _resetModels();
  upsertModel(personalModel()); // owner sara, domain sales
  const domainAdmin: Actor = { id: 'dana', role: 'domain_admin', domains: ['sales'], isAgent: false };
  assert.equal(setModelArchived('test_model', domainAdmin, true).archived, true);
  // a domain_admin of ANOTHER domain is out of scope.
  const otherDomainAdmin: Actor = { id: 'omar', role: 'domain_admin', domains: ['ops'], isAgent: false };
  assert.throws(() => setModelArchived('test_model', otherDomainAdmin, false), /domain you belong to/i);
});
