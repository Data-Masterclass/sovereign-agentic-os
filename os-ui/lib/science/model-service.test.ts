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
  createModel,
  ensureChurnSeed,
  churnSeedModel,
  assertCanTrain,
  startTraining,
  completeTraining,
  failTraining,
  assertCanDeploy,
  startDeploy,
  completeDeploy,
  failDeploy,
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

// A SHARED (Domain-tier) model — the scope where a non-owner domain_admin/admin
// has management authority (a Personal model is owner-only under the manage-rights
// rule, so admin/domain_admin lifecycle tests use this shared model).
function domainModel(): ServiceModel {
  return { ...personalModel(), tier: 'Domain' };
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
  upsertModel(domainModel()); // SHARED model → an in-domain admin may manage it
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
  upsertModel(domainModel()); // SHARED model → an in-domain admin may manage it
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

test('archive/delete: a domain_admin of the owning domain MAY manage a non-owned SHARED model', () => {
  _resetModels();
  upsertModel(domainModel()); // owner sara, domain sales, SHARED (Domain) tier
  const domainAdmin: Actor = { id: 'dana', role: 'domain_admin', domains: ['sales'], isAgent: false };
  assert.equal(setModelArchived('test_model', domainAdmin, true).archived, true);
  // a domain_admin of ANOTHER domain is out of scope.
  const otherDomainAdmin: Actor = { id: 'omar', role: 'domain_admin', domains: ['ops'], isAgent: false };
  assert.throws(() => setModelArchived('test_model', otherDomainAdmin, false), /domain you belong to/i);
});

test('archive/delete: a PERSONAL model is owner-only — no admin, no domain_admin', () => {
  _resetModels();
  upsertModel(personalModel()); // owner sara, domain sales, Personal tier
  // A platform admin (not the owner) may NOT manage another user's private model.
  assert.throws(() => setModelArchived('test_model', admin('sales'), true), /owner|Domain admin|Admin/i);
  const domainAdmin: Actor = { id: 'dana', role: 'domain_admin', domains: ['sales'], isAgent: false };
  assert.throws(() => setModelArchived('test_model', domainAdmin, true), /owner|Domain admin|Admin/i);
  // The owner still manages their own private model.
  const sara: Actor = { id: 'sara', role: 'creator', domains: ['sales'], isAgent: false };
  assert.equal(setModelArchived('test_model', sara, true).archived, true);
});

// ------------------------------------------------------------- createModel (Phase 1)

const spec = () => ({
  sourceDataProductFqn: 'sales.customer_360',
  targetColumn: 'churned',
  taskType: 'binary_classification' as const,
  algorithm: 'xgboost',
  features: ['recency_days', 'tenure_months'],
  trainTestSplit: 0.8,
  optimizeMetric: 'auc',
});

test('createModel registers a draft Personal model owned by the actor, in their domain', () => {
  _resetModels();
  const m = createModel({ name: 'Lead scoring', description: 'score leads', spec: spec() }, builder('sales'));
  assert.equal(m.model, 'lead_scoring'); // slugged
  assert.equal(m.owner, 'b');
  assert.equal(m.domain, 'sales');
  assert.equal(m.tier, 'Personal');
  assert.equal(m.buildState, 'draft');
  assert.equal(m.stage, 'Staging');
  assert.deepEqual(m.frontDoors, ['rest', 'mcp']);
  assert.equal(m.spec?.taskType, 'binary_classification');
  assert.ok(m.createdAt && m.updatedAt);
  // It's in the registry + RLS-visible to its owner as a Personal model.
  assert.equal(getModel('lead_scoring')?.name, 'Lead scoring');
  const mine = listModelsForUser({ id: 'b', domains: ['sales'] });
  assert.ok(mine.some((x) => x.model === 'lead_scoring'));
});

test('createModel rejects agents, empty names, missing domain, and duplicates', () => {
  _resetModels();
  assert.throws(() => createModel({ name: 'X', spec: spec() }, agentActor('sales')), /agent cannot create/i);
  assert.throws(() => createModel({ name: '   ', spec: spec() }, builder('sales')), /needs a name/i);
  assert.throws(
    () => createModel({ name: 'Y', spec: spec() }, { id: 'u', role: 'user', domains: [], isAgent: false }),
    /belong to a domain/i,
  );
  createModel({ name: 'Dup', spec: spec() }, builder('sales'));
  assert.throws(() => createModel({ name: 'Dup', spec: spec() }, builder('sales')), /already exists/i);
});

test('createModel: a base user (creator) MAY create their own draft in their domain', () => {
  _resetModels();
  const m = createModel({ name: 'My draft', spec: spec() }, { id: 'sara', role: 'user', domains: ['sales'], isAgent: false });
  assert.equal(m.owner, 'sara');
  assert.equal(m.tier, 'Personal');
});

// ------------------------------------------------------ churn seed (the first model)

test('ensureChurnSeed wraps the live churn/KServe slice as the first trained+deployed model', () => {
  _resetModels();
  assert.equal(getModel('churn_model'), null, 'registry starts empty');
  const m = ensureChurnSeed('sara', 'sales');
  assert.equal(m.model, 'churn_model');
  assert.equal(m.buildState, 'deployed');
  assert.equal(m.spec?.taskType, 'binary_classification');
  assert.equal(m.kserveService, 'churn_model');
  assert.ok(m.versions.some((v) => v.stage === 'Production' && v.certified));
  // Idempotent — a second call does not duplicate or clobber.
  const again = ensureChurnSeed('someone-else', 'other');
  assert.equal(again.owner, 'sara', 'pre-existing model is returned unchanged');
  assert.equal(listModels().filter((x) => x.model === 'churn_model').length, 1);
  // The churn seed appears in its owner's RLS-scoped list.
  assert.ok(listModelsForUser({ id: 'sara', domains: ['sales'] }).some((x) => x.model === 'churn_model'));
});

test('churnSeedModel has a FIXED identity (system/sales, Domain tier) — never the first viewer', () => {
  const m = churnSeedModel();
  assert.equal(m.owner, 'system'); // stable across pods/users — not whoever opened the tab
  assert.equal(m.domain, 'sales');
  assert.equal(m.tier, 'Domain'); // the owning domain can see + call it out of the box
  assert.equal(nextTier(m.tier), 'Marketplace'); // certify rung still walkable
  assert.deepEqual(compilePredictPolicy(m).allowedDomains, ['sales']);
});

test('ensureChurnSeed only seeds an EMPTY registry — a deleted model stays deleted', () => {
  _resetModels();
  upsertModel(personalModel()); // a user model already exists (e.g. hydrated back)
  assert.equal(ensureChurnSeed(), null, 'non-empty registry: churn is NOT resurrected');
  assert.equal(getModel('churn_model'), null);
});

// ------------------------------------------------------------ train transitions ---

const owner = (): Actor => ({ id: 'sara', role: 'user', domains: ['sales'], isAgent: false });

test('startTraining flips draft→training and stamps the run handle (owner-scoped)', () => {
  _resetModels();
  createModel({ name: 'Lead scoring', spec: spec() }, owner());
  const m = startTraining('lead_scoring', owner(), { jobName: 'train-lead-scoring-x', namespace: 'agentic-os' });
  assert.equal(m.buildState, 'training');
  assert.equal(m.trainingJob, 'train-lead-scoring-x');
  assert.equal(m.trainingNamespace, 'agentic-os');
});

test('startTraining is a typed 409 while a run is already in flight', () => {
  _resetModels();
  createModel({ name: 'Lead scoring', spec: spec() }, owner());
  startTraining('lead_scoring', owner(), { jobName: 'j1', namespace: 'ns' });
  assert.throws(
    () => startTraining('lead_scoring', owner(), { jobName: 'j2', namespace: 'ns' }),
    (e: any) => e.status === 409,
  );
});

test('assertCanTrain rejects a non-owner, an agent, and a specless model', () => {
  _resetModels();
  createModel({ name: 'Lead scoring', spec: spec() }, owner());
  // A different user in the same domain but NOT owner/admin cannot train.
  assert.throws(
    () => assertCanTrain('lead_scoring', { id: 'other', role: 'user', domains: ['sales'], isAgent: false }),
    /Only the owner/i,
  );
  // An agent can never drive training.
  assert.throws(() => assertCanTrain('lead_scoring', agentActor('sales')), /agent cannot/i);
});

test('completeTraining registers a Staging version + metric and lands trained', () => {
  _resetModels();
  createModel({ name: 'Lead scoring', spec: spec() }, owner());
  startTraining('lead_scoring', owner(), { jobName: 'j', namespace: 'ns' });
  const m = completeTraining('lead_scoring', owner(), { runId: 'mlf-run-1', metric: 0.83, metricName: 'auc' });
  assert.equal(m.buildState, 'trained');
  assert.equal(m.versions.length, 1);
  assert.equal(m.versions[0].version, 'v1');
  assert.equal(m.versions[0].stage, 'Staging');
  assert.equal(m.versions[0].certified, false);
  assert.equal(m.metrics?.primary, 0.83);
  assert.equal(m.mlflowRunId, 'mlf-run-1');
  assert.equal(m.trainingJob, undefined); // handle cleared on completion
});

test('failTraining resets training→draft and records the reason', () => {
  _resetModels();
  createModel({ name: 'Lead scoring', spec: spec() }, owner());
  startTraining('lead_scoring', owner(), { jobName: 'j', namespace: 'ns' });
  const m = failTraining('lead_scoring', owner(), 'BackoffLimitExceeded');
  assert.equal(m.buildState, 'draft');
  assert.equal(m.lastTrainingError, 'BackoffLimitExceeded');
  assert.equal(m.trainingJob, undefined);
});

// ------------------------------------------------------------ deploy transitions ---

function trainedModel(): void {
  _resetModels();
  createModel({ name: 'Lead scoring', spec: spec() }, owner());
  startTraining('lead_scoring', owner(), { jobName: 'j', namespace: 'ns' });
  completeTraining('lead_scoring', owner(), { runId: 'r1', metric: 0.83, metricName: 'auc' });
}

test('startDeploy flips trained→deploying and stamps the InferenceService name', () => {
  trainedModel();
  const m = startDeploy('lead_scoring', owner(), 'lead-scoring');
  assert.equal(m.buildState, 'deploying');
  assert.equal(m.kserveService, 'lead-scoring');
});

test('completeDeploy lands deployed; failDeploy lands deploy_failed with the reason', () => {
  trainedModel();
  startDeploy('lead_scoring', owner(), 'lead-scoring');
  const done = completeDeploy('lead_scoring', owner());
  assert.equal(done.buildState, 'deployed');
  assert.equal(done.lastDeployError, undefined);
  // Re-deploy then fail.
  startDeploy('lead_scoring', owner(), 'lead-scoring');
  const failed = failDeploy('lead_scoring', owner(), 'model load failed (BlockedByFailedLoad)');
  assert.equal(failed.buildState, 'deploy_failed');
  assert.match(failed.lastDeployError ?? '', /BlockedByFailedLoad/);
  // A deploy_failed model may be re-deployed (retry path).
  assert.equal(startDeploy('lead_scoring', owner(), 'lead-scoring').buildState, 'deploying');
});

test('assertCanDeploy is FAIL-CLOSED: untrained 400, in-flight 409, agents + non-owners rejected', () => {
  _resetModels();
  createModel({ name: 'Lead scoring', spec: spec() }, owner());
  // draft (never trained) → typed 400: there is no artifact to serve.
  assert.throws(() => assertCanDeploy('lead_scoring', owner()), (e: any) => e.status === 400);
  // training in flight → typed 409.
  startTraining('lead_scoring', owner(), { jobName: 'j', namespace: 'ns' });
  assert.throws(() => assertCanDeploy('lead_scoring', owner()), (e: any) => e.status === 409);
  completeTraining('lead_scoring', owner(), { runId: 'r1', metric: 0.8 });
  // an agent can never drive a deploy.
  assert.throws(() => assertCanDeploy('lead_scoring', agentActor('sales')), /agent cannot/i);
  // a same-domain non-owner (no admin rank) is edit-scoped out.
  assert.throws(
    () => assertCanDeploy('lead_scoring', { id: 'other', role: 'user', domains: ['sales'], isAgent: false }),
    /Only the owner/i,
  );
  // deploying in flight → second submit is a typed 409.
  startDeploy('lead_scoring', owner(), 'lead-scoring');
  assert.throws(() => startDeploy('lead_scoring', owner(), 'lead-scoring'), (e: any) => e.status === 409);
  // unknown model → typed 404.
  assert.throws(() => assertCanDeploy('nope', owner()), (e: any) => e.status === 404);
});

// ------------------------------------------------- owner self-consumption (predict)

test('the OWNER may predict their own model without a third-party OPA grant (both principal forms)', async () => {
  trainedModel(); // owner sara, Personal tier
  const bare = await authorizePredict('lead_scoring', { principal: 'sara', domains: ['sales'], isAgent: false }, denyPredict);
  assert.equal(bare.decision, 'allow');
  assert.equal(bare.toolPolicy, 'owner-self');
  const sessionForm = await authorizePredict('lead_scoring', { principal: 'user:sara', domains: ['sales'], isAgent: false }, denyPredict);
  assert.equal(sessionForm.decision, 'allow');
  // A NON-owner in scope still needs the OPA grant (deny stays deny).
  promoteModel('lead_scoring', builder('sales'));
  const other = await authorizePredict('lead_scoring', { principal: 'user:bob', domains: ['sales'], isAgent: false }, denyPredict);
  assert.equal(other.decision, 'deny');
});
