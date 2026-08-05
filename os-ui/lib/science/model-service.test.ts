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
  demoteModel,
  goLive,
  certifyModel,
  nextTier,
  setModelArchived,
  deleteModel,
  renameModel,
  moveModel,
  createModel,
  normalizeSpec,
  recordUsage,
  computeLaunchStatus,
  assertCanTrain,
  startTraining,
  completeTraining,
  failTraining,
  assertCanDeploy,
  startDeploy,
  completeDeploy,
  failDeploy,
} from './model-service.ts';
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
    versions: [{ version: 'v1', stage: 'Staging', metric: 0.8, metricName: 'auc', auc: 0.8, certified: false, runId: 'r1' }],
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
    versions: [{ version: 'v2', stage: 'Production', metric: 0.871, metricName: 'auc', auc: 0.871, certified: true, runId: 'mlf-run-2a9c' }],
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

  // Strict isolation: EVERY tier (incl the Marketplace/Company `mp_model`, homed in sales)
  // narrows to the active domain. Owner in sales: own Personal + sales Domain + the sales-
  // homed Marketplace model; NOT marketing's Domain model.
  assert.deepEqual(
    new Set(listModelsForUser({ id: 'sara', domains: ['sales'] }).map((x) => x.model)),
    new Set(['p_model', 'd_model', 'mp_model']),
  );
  // A different sales user: sales Domain + the sales-homed Marketplace model, but NOT sara's Personal.
  assert.deepEqual(
    new Set(listModelsForUser({ id: 'bob', domains: ['sales'] }).map((x) => x.model)),
    new Set(['d_model', 'mp_model']),
  );
  // A marketing user: ONLY marketing's Domain model — the sales-homed Marketplace model does
  // NOT leak across domains here (cross-domain discovery is the dedicated Marketplace catalog's job).
  assert.deepEqual(
    new Set(listModelsForUser({ id: 'mara', domains: ['marketing'] }).map((x) => x.model)),
    new Set(['dm_model']),
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
  algorithm: 'logistic', // the supported classification learner (xgboost is refused, by design)
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

// ---------------------------------------- rename: DISPLAY name + FROZEN serving key --

test('renameModel: SERVING-KEY STABILITY — a rename changes the display name but NEVER `model`', () => {
  _resetModels();
  // Create "Foo" — its serving/deploy key `model` is slugged ONCE at create.
  const m = createModel({ name: 'Foo', spec: spec() }, builder('sales'));
  assert.equal(m.model, 'foo');
  assert.equal(m.kserveService, 'foo');

  // Rename Foo → Bar.
  const renamed = renameModel('foo', builder('sales'), 'Bar');
  assert.equal(renamed.name, 'Bar');             // display name changed
  assert.equal(renamed.model, 'foo');            // serving/deploy key FROZEN
  assert.equal(renamed.kserveService, 'foo');    // KServe InferenceService unmoved

  // Still keyed + resolvable by the ORIGINAL slug, never by slug("Bar") === "bar".
  assert.equal(getModel('foo')?.name, 'Bar');
  assert.equal(getModel('bar'), null, 'no record ever lands under the renamed slug');
  // The compiled policy principal is derived from `model`, so it stays frozen too.
  assert.ok(compilePredictPolicy(renamed).allowedPrincipals.includes('foo'));
});

test('renameModel: a rename does NOT re-derive/re-collide `model` (create-uniqueness preserved)', () => {
  _resetModels();
  createModel({ name: 'Alpha', spec: spec() }, builder('sales')); // model 'alpha'
  const beta = createModel({ name: 'Beta', spec: spec() }, builder('sales')); // model 'beta'
  // Renaming Beta's DISPLAY name to "Alpha" is fine — `model` stays 'beta', no slug collision.
  const r = renameModel('beta', builder('sales'), 'Alpha');
  assert.equal(r.model, 'beta');
  assert.equal(r.name, 'Alpha');
  assert.equal(getModel('alpha')?.model, 'alpha', 'the original alpha record is untouched');
});

test('renameModel: edit-scoped — owner ok; a shared model admits domain_admin; unauthorized 403', () => {
  _resetModels();
  // A PERSONAL model is owner-only. Owner (sara) may rename it.
  upsertModel(personalModel()); // owner sara, sales, Personal
  const sara: Actor = { id: 'sara', role: 'creator', domains: ['sales'], isAgent: false };
  assert.equal(renameModel('test_model', sara, 'Renamed').name, 'Renamed');
  // A non-owner builder cannot manage a PRIVATE model.
  assert.throws(() => renameModel('test_model', builder('sales'), 'Hijack'), (e) => (e as { status?: number }).status === 403);

  // A SHARED (Domain-tier) model admits an in-domain domain_admin.
  _resetModels();
  upsertModel(domainModel());
  const domainAdmin: Actor = { id: 'dana', role: 'domain_admin', domains: ['sales'], isAgent: false };
  assert.equal(renameModel('test_model', domainAdmin, 'Shared Renamed').name, 'Shared Renamed');
  // An out-of-domain admin is denied; an agent is always rejected.
  assert.throws(() => renameModel('test_model', admin('marketing'), 'Nope'), (e) => (e as { status?: number }).status === 403);
  assert.throws(() => renameModel('test_model', agentActor('sales'), 'Nope'), /agent cannot/i);
});

test('renameModel: rejects an empty name (400) and no-ops an unchanged name', () => {
  _resetModels();
  const sara: Actor = { id: 'sara', role: 'creator', domains: ['sales'], isAgent: false };
  upsertModel(personalModel()); // name 'Test'
  assert.throws(() => renameModel('test_model', sara, '   '), (e) => (e as { status?: number }).status === 400);
  const before = getModel('test_model')!.updatedAt;
  const same = renameModel('test_model', sara, 'Test'); // no-op
  assert.equal(same.name, 'Test');
  assert.equal(same.updatedAt, before, 'a no-op rename never churns updatedAt');
});

// -------------------------------------------------------- move into a folder (edit) --

test('moveModel: sets the folder, survives a re-read, and is edit-scoped', () => {
  _resetModels();
  upsertModel(domainModel()); // shared Domain model, owner sara, sales
  const domainAdmin: Actor = { id: 'dana', role: 'domain_admin', domains: ['sales'], isAgent: false };
  // Default folder is root when never set.
  const m = moveModel('test_model', domainAdmin, '/Models/Churn');
  assert.equal(m.folder, '/Models/Churn'); // normalised path
  assert.equal(getModel('test_model')?.folder, '/Models/Churn', 'survives a registry re-read');
  // Renaming does NOT disturb the folder; moving does NOT disturb the serving key.
  assert.equal(m.model, 'test_model');
  // A non-owner, out-of-domain admin cannot move it.
  assert.throws(() => moveModel('test_model', admin('marketing'), '/Elsewhere'), (e) => (e as { status?: number }).status === 403);
  // Agents are always rejected.
  assert.throws(() => moveModel('test_model', agentActor('sales'), '/Nope'), /agent cannot/i);
});

test('moveModel: a PERSONAL model is owner-only — a non-owner builder is 403', () => {
  _resetModels();
  upsertModel(personalModel()); // Personal, owner sara
  assert.throws(() => moveModel('test_model', builder('sales'), '/Mine'), (e) => (e as { status?: number }).status === 403);
  const sara: Actor = { id: 'sara', role: 'creator', domains: ['sales'], isAgent: false };
  assert.equal(moveModel('test_model', sara, '/Mine').folder, '/Mine');
});

// ------------------------------------------- no fabricated seed (fresh tenant is EMPTY)

test('a fresh tenant registry is EMPTY — no fabricated churn seed is ever planted', () => {
  _resetModels();
  assert.equal(getModel('churn_model'), null, 'no invented churn model in a fresh registry');
  assert.equal(listModels().length, 0, 'registry ships empty — models are earned via create/train');
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
  // Metric-name-correct version: value + real name (auc kept as deprecated back-compat mirror).
  assert.equal(m.versions[0].metric, 0.83);
  assert.equal(m.versions[0].metricName, 'auc');
  assert.equal(m.versions[0].auc, 0.83); // deprecated mirror equals the value
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

// ------------------------------------------------- active-domain scoping (0.6.x) --

test('active-domain: Personal model in domain A does NOT appear for owner when domain B is active', () => {
  _resetModels();
  upsertModel({ ...personalModel(), owner: 'sara', domain: 'sales', tier: 'Personal' });
  // Simulate "domain B (finance) active": viewer.domains narrowed to ['finance']
  const result = listModelsForUser({ id: 'sara', domains: ['finance'] });
  assert.ok(!result.some((m) => m.model === 'test_model'), 'sales Personal model must not appear when finance domain is active');
});

test('active-domain: Personal model in domain A DOES appear for owner when domain A is active', () => {
  _resetModels();
  upsertModel({ ...personalModel(), owner: 'sara', domain: 'sales', tier: 'Personal' });
  const result = listModelsForUser({ id: 'sara', domains: ['sales'] });
  assert.ok(result.some((m) => m.model === 'test_model'), 'sales Personal model must appear when sales domain is active');
});

test('active-domain: Personal model appears when All Domains is active (viewer.domains = all)', () => {
  _resetModels();
  upsertModel({ ...personalModel(), owner: 'sara', domain: 'sales', tier: 'Personal' });
  // Simulate "All Domains": viewer.domains = every membership
  const result = listModelsForUser({ id: 'sara', domains: ['sales', 'finance'] });
  assert.ok(result.some((m) => m.model === 'test_model'), 'sales Personal model must appear when All Domains is active');
});

test('active-domain: the per-tab Company (Marketplace) tier IS narrowed by active domain', () => {
  // Strict-isolation model: a Marketplace model homed in sales does NOT show for a
  // finance user. Cross-domain discovery is the dedicated Marketplace catalog's job.
  _resetModels();
  upsertModel({ ...personalModel(), tier: 'Marketplace' }); // domain = sales
  assert.ok(!listModelsForUser({ id: 'bob', domains: ['finance'] }).some((m) => m.model === 'test_model'),
    'a sales-homed Marketplace model must NOT show for a finance user');
  assert.ok(listModelsForUser({ id: 'bob', domains: ['sales'] }).some((m) => m.model === 'test_model'),
    'it shows for a sales user');
});

// ------------------------------------------------------------- demoteModel (revoke sharing)

test('demoteModel: Domain -> Personal by the owner; Marketplace -> Domain is Admin-only', () => {
  const owner = builder('sales');
  const m = createModel({ name: 'Demote me', description: 'd', spec: spec() }, owner);
  promoteModel(m.model, owner);
  assert.equal(demoteModel(m.model, owner).tier, 'Personal');

  const a = admin('sales');
  const m2 = createModel({ name: 'Certify me', description: 'd', spec: spec() }, a);
  promoteModel(m2.model, a);
  certifyModel(m2.model, a, 'read_in_place');
  // A non-admin (even the in-domain builder) cannot revoke a certification.
  assert.throws(() => demoteModel(m2.model, owner), /requires an Admin/);
  const back = demoteModel(m2.model, a);
  assert.equal(back.tier, 'Domain');
  assert.equal(back.consumptionMode, undefined, 'the certification-time consumption mode is cleared');
});

test('demoteModel: gates — stranger denied, agent denied, Personal is a no-op error', () => {
  const owner = builder('sales');
  const m = createModel({ name: 'Guarded', description: 'd', spec: spec() }, owner);
  promoteModel(m.model, owner);
  // A different non-admin builder in the same domain is NOT the manage scope.
  const stranger: Actor = { id: 'x', role: 'builder', domains: ['sales'], isAgent: false };
  assert.throws(() => demoteModel(m.model, stranger), /Only the owner/);
  // An agent can never demote.
  const agent: Actor = { id: 'bot', role: 'admin', domains: ['sales'], isAgent: true };
  assert.throws(() => demoteModel(m.model, agent));
  // Back to Personal, then nothing to revoke.
  demoteModel(m.model, owner);
  assert.throws(() => demoteModel(m.model, owner), /already personal/);
});

// ---------------------------------------------- Phase A: Simple-mode spec defaults --

test('normalizeSpec fills task defaults when the tuning knobs are omitted', () => {
  // Classification → the real default learner + auc, split 0.8.
  const c = normalizeSpec({
    sourceDataProductFqn: 'sales.customer_360', targetColumn: 'churned',
    taskType: 'binary_classification', features: ['recency_days'],
  });
  assert.equal(c.algorithm, 'logistic');
  assert.equal(c.optimizeMetric, 'auc');
  assert.equal(c.trainTestSplit, 0.8);
  // Regression → linear/rmse.
  const r = normalizeSpec({
    sourceDataProductFqn: 'sales.orders', targetColumn: 'ltv',
    taskType: 'regression', features: ['tenure_months'],
  });
  assert.equal(r.algorithm, 'linear');
  assert.equal(r.optimizeMetric, 'rmse');
});

test('normalizeSpec REFUSES an unsupported algorithm by name — never silently substitutes', () => {
  // The old lie: typing "xgboost" quietly trained logistic. Now it is an honest 400.
  assert.throws(
    () => normalizeSpec({
      sourceDataProductFqn: 'sales.customer_360', targetColumn: 'churned',
      taskType: 'binary_classification', algorithm: 'xgboost', features: ['recency_days'],
    }),
    (e: any) => e.status === 400 && /not supported/i.test(e.message) && /logistic/.test(e.message),
  );
});

test('createModel accepts a Simple spec (no algorithm) and refuses an unsupported one', () => {
  _resetModels();
  const m = createModel(
    { name: 'Simple churn', spec: { sourceDataProductFqn: 'sales.customer_360', targetColumn: 'churned', taskType: 'binary_classification', features: ['recency_days'] } },
    builder('sales'),
  );
  assert.equal(m.spec?.algorithm, 'logistic'); // default filled
  assert.equal(m.spec?.optimizeMetric, 'auc');
  assert.throws(
    () => createModel(
      { name: 'Bad algo', spec: { sourceDataProductFqn: 'x', targetColumn: 'y', taskType: 'regression', algorithm: 'prophet', features: ['a'] } },
      builder('sales'),
    ),
    (e: any) => e.status === 400 && /not supported/i.test(e.message),
  );
});

// ---------------------------------------------- Phase A: metric-name-correct versions --

test('completeTraining records the REAL metric name for a regression model (rmse, not AUC)', () => {
  _resetModels();
  createModel(
    { name: 'LTV model', spec: { sourceDataProductFqn: 'sales.orders', targetColumn: 'ltv', taskType: 'regression', features: ['tenure_months'] } },
    owner(),
  );
  startTraining('ltv_model', owner(), { jobName: 'j', namespace: 'ns' });
  const m = completeTraining('ltv_model', owner(), { runId: 'r1', metric: 12.3, metricName: 'rmse' });
  assert.equal(m.versions[0].metric, 12.3);
  assert.equal(m.versions[0].metricName, 'rmse'); // NOT mislabeled 'auc'
  assert.equal(m.versions[0].auc, 12.3); // deprecated mirror carries the value
  assert.equal(m.metrics?.primaryMetric, 'rmse');
});

// ---------------------------------------------- Phase A: fused Train & launch status --

test('computeLaunchStatus maps buildState onto ordered read→train→publish steps', () => {
  _resetModels();
  createModel({ name: 'Fused', spec: spec() }, owner());
  // draft → all pending
  let s = computeLaunchStatus(getModel('fused')!);
  assert.deepEqual(s.steps.map((x) => x.key), ['read', 'train', 'publish']);
  assert.deepEqual(s.steps.map((x) => x.state), ['pending', 'pending', 'pending']);
  assert.equal(s.launched, false);

  // training → read done, train running
  startTraining('fused', owner(), { jobName: 'train-fused-x', namespace: 'ns' });
  s = computeLaunchStatus(getModel('fused')!, 'succeeded');
  assert.deepEqual(s.steps.map((x) => x.state), ['done', 'running', 'pending']);
  assert.match(s.steps[1].detail ?? '', /succeeded|train-fused-x/);

  // trained → train done, publish pending
  completeTraining('fused', owner(), { runId: 'r1', metric: 0.8, metricName: 'auc' });
  s = computeLaunchStatus(getModel('fused')!);
  assert.deepEqual(s.steps.map((x) => x.state), ['done', 'done', 'pending']);

  // deploying → publish running
  startDeploy('fused', owner(), 'fused');
  s = computeLaunchStatus(getModel('fused')!, 'progressing');
  assert.deepEqual(s.steps.map((x) => x.state), ['done', 'done', 'running']);

  // deployed → launched, all done
  completeDeploy('fused', owner());
  s = computeLaunchStatus(getModel('fused')!);
  assert.deepEqual(s.steps.map((x) => x.state), ['done', 'done', 'done']);
  assert.equal(s.launched, true);
  assert.equal(s.phase, 'deployed');
});

test('computeLaunchStatus surfaces an honest failure on the failing step', () => {
  _resetModels();
  createModel({ name: 'Fails', spec: spec() }, owner());
  startTraining('fails', owner(), { jobName: 'j', namespace: 'ns' });
  failTraining('fails', owner(), 'BackoffLimitExceeded');
  let s = computeLaunchStatus(getModel('fails')!);
  assert.equal(s.steps[1].state, 'failed');
  assert.equal(s.error, 'BackoffLimitExceeded');

  // deploy_failed carries the deploy error on publish.
  completeTraining('fails', owner(), { runId: 'r1', metric: 0.8 });
  startDeploy('fails', owner(), 'fails');
  failDeploy('fails', owner(), 'model load failed (BlockedByFailedLoad)');
  s = computeLaunchStatus(getModel('fails')!);
  assert.equal(s.steps[2].state, 'failed');
  assert.match(s.error ?? '', /BlockedByFailedLoad/);
});

// ---------------------------------------------- Phase A: real per-model usage recording --

test('recordUsage counts allow + deny, stamps lastCalledAt, and buckets scored calls by day×decile', () => {
  _resetModels();
  createModel({ name: 'Used', spec: spec() }, owner()); // binary_classification → decile bands
  const day = new Date('2026-06-27T10:00:00Z');
  recordUsage('used', { allowed: true, score: 0.72, at: day }); // d7
  recordUsage('used', { allowed: true, score: 0.75, at: day }); // d7 again
  recordUsage('used', { allowed: true, score: 0.10, at: day }); // d1
  recordUsage('used', { allowed: false, at: day });             // denied → counts, no bucket
  const u = getModel('used')!.usage!;
  assert.equal(u.count, 4);
  assert.equal(u.denied, 1);
  assert.equal(u.lastCalledAt, day.toISOString());
  assert.equal(u.bandKind, 'decile');
  assert.equal(u.buckets['2026-06-27'].d7, 2);
  assert.equal(u.buckets['2026-06-27'].d1, 1);
  // A second day opens a new bucket key (time axis for the chart).
  recordUsage('used', { allowed: true, score: 0.5, at: new Date('2026-06-28T09:00:00Z') }); // d5
  assert.equal(getModel('used')!.usage!.buckets['2026-06-28'].d5, 1);
  assert.equal(getModel('used')!.usage!.count, 5);
});

test('recordUsage uses value-band buckets for a regression model and no-ops an unknown model', () => {
  _resetModels();
  createModel(
    { name: 'Reg', spec: { sourceDataProductFqn: 'x', targetColumn: 'y', taskType: 'regression', features: ['a'] } },
    owner(),
  );
  recordUsage('reg', { allowed: true, score: 123.4, at: new Date('2026-06-27T00:00:00Z') });
  const u = getModel('reg')!.usage!;
  assert.equal(u.bandKind, 'value-band');
  assert.ok(Object.keys(u.buckets['2026-06-27']).some((k) => k.startsWith('b')));
  // Unknown model → no throw, no record.
  assert.equal(recordUsage('nope', { allowed: true, score: 0.5 }), null);
});
