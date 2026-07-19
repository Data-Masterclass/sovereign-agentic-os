/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
// NOTE: deliberately NOT `import 'server-only'` and NO top-level VALUE `@/`
// imports — this module holds the pure governance spine + an in-process registry
// and is unit-tested with `node --test` (which resolves neither). The single
// live dependency (OPA `authorize`) is dependency-injected into
// `authorizePredict` and dynamically imported by default, so tests inject a stub
// and never touch the alias chain. Type-only `@/` imports are stripped by Node.
import type { Authz } from '@/lib/infra/agent-governed';
import type {
  Actor,
  Caller,
  CompiledPredictPolicy,
  ConsumptionMode,
  ModelSpec,
  ModelTier,
  ServiceModel,
} from '@/lib/science/types';
// Pure edit-scope helper (type-only dep chain — safe under `node --test`).
import { canManageArtifact, type ArtifactScope } from '../governance/edit-scope.ts';
// Durable best-effort mirror (relative import — node-test-safe, no `@/` value chain).
import { osMirror } from '../infra/os-mirror.ts';

/**
 * Model-as-service governance — the Opus spine of the Science golden path.
 *
 * A deployed model is governed exactly like every other artifact: ONE visibility
 * ladder decides who may call its `predict` service through EITHER front door
 * (REST API for Software/external, MCP tool for agents). The ladder is
 *
 *   Personal ──(Builder promote)──▶ Domain ──(Admin certify)──▶ Marketplace
 *
 * and the three load-bearing invariants are:
 *
 *   1. Promotion / certification AUTOMATICALLY widens callable scope — there is
 *      NO separate "publish" step. `compilePredictPolicy()` is the policy-compiler
 *      mirror that turns the model's tier into the OPA `predict` data bundle; both
 *      front doors evaluate the SAME compiled policy, so REST and MCP cannot drift
 *      (the same guarantee `data-policy-compiler.md` makes for Trino-vs-Cube).
 *   2. Certify, go-live, and promotion are ALWAYS performed by a human Builder/
 *      Admin. An agent actor is rejected by `assertHuman()` — the ML agent
 *      proposes, a human ships (see `agent-control.ts`).
 *   3. The owner picks the Marketplace consumption mode (read-in-place vs
 *      fork-allowed) AT certify time, per artifact.
 *
 * Persistence mirrors `lib/dashboards/store.ts`: an authoritative in-process
 * registry (the cache) with a best-effort DURABLE write-through to the shared
 * OpenSearch mirror (`os-science-models`), hydrated lazily — so user-created
 * models survive a pod roll instead of vanishing with the process. Offline
 * (laptop, `ml.enabled=false`) the mirror is simply unreachable and the flow
 * stays fully demonstrable in-memory. No secrets here; the live OPA grant is the
 * source of truth in prod and `authorizePredict()` consults it first, falling
 * back to this compiled mirror.
 */

function withStatus(err: Error, status: number): Error {
  (err as Error & { status?: number }).status = status;
  return err;
}

// --------------------------------------------------------- The model registry ---

/**
 * Seed: the churn model — owned by Sales, deployed (Production stage) but its
 * SERVICE visibility starts at **Personal** (owner-only), so the UI/gate can walk
 * the FULL ladder: Personal (owner only) → Builder promote → Domain (the Sales
 * app + agent can call) → Admin certify → Marketplace (a second domain can call).
 * Stage (MLflow lifecycle) and tier (who-may-call) are orthogonal.
 */
function seedModels(): ServiceModel[] {
  // A fresh tenant starts EMPTY. Models are registered only through the
  // platform's own promote/certify flows (e.g. the Northpeak e-commerce seed).
  return [];
}

/**
 * The churn/KServe slice as a FULL model artifact — the one live backend, wrapped
 * as the first `trained`+`deployed` model so the Science tab is never empty and has
 * a real thing to open/predict/promote. Seeded with a FIXED identity (the platform
 * `system` owner, `sales` domain) — never the first viewer, so ownership is stable
 * across pods and users. Domain tier so the owning domain can see + call it out of
 * the box (and the Domain→Marketplace certify rung stays walkable); Production
 * stage + a certified v2 version mirror the live MLflow registry. Tests seed their
 * own churn variants explicitly via `upsertModel`.
 */
export function churnSeedModel(owner = 'system', domain = 'sales'): ServiceModel {
  const now = new Date().toISOString();
  return {
    id: 'svc_churn_model',
    model: 'churn_model',
    name: 'Churn model',
    owner,
    domain,
    tier: 'Domain',
    stage: 'Production',
    frontDoors: ['rest', 'mcp'],
    versions: [{ version: 'v2', stage: 'Production', auc: 0.871, certified: true, runId: 'mlf-run-2a9c' }],
    spec: {
      sourceDataProductFqn: 'sales.customer_360',
      targetColumn: 'churned',
      taskType: 'binary_classification',
      algorithm: 'xgboost',
      features: ['recency_days', 'order_frequency', 'monetary_value', 'tenure_months'],
      trainTestSplit: 0.8,
      optimizeMetric: 'auc',
    },
    buildState: 'deployed',
    description: 'Predicts customer churn from RFM + tenure features. Served by KServe; the live Layer-4 slice.',
    metrics: { primary: 0.871, primaryMetric: 'auc' },
    mlflowRunId: 'mlf-run-2a9c',
    kserveService: 'churn_model',
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Ensure the wrapped churn model exists (idempotent) — the route calls this so a
 * fresh tenant's Science tab opens on the live model rather than an empty grid.
 * Seeds ONLY into an EMPTY registry (call it AFTER `ensureModelsHydrated()`): once
 * any model exists — including a durably deleted churn model with other survivors —
 * the seed never resurrects. Returns the churn model now in the registry, or null
 * when it is absent and the registry is non-empty.
 */
export function ensureChurnSeed(owner?: string, domain?: string): ServiceModel | null {
  const existing = getModel('churn_model');
  if (existing) return existing;
  if (store().size > 0) return null;
  return upsertModel(churnSeedModel(owner, domain));
}

// The registry state is pinned to globalThis so all separately-bundled Next.js
// route handlers share ONE Map (and it survives dev HMR) — same pattern as every
// other durable store (dashboards, data, …).
type ModelState = { models: Map<string, ServiceModel>; hydration: Promise<void> | null };
const MODELS_KEY = Symbol.for('soa.science.models');
function modelState(): ModelState {
  const g = globalThis as unknown as Record<symbol, ModelState | undefined>;
  if (!g[MODELS_KEY]) {
    const models = new Map<string, ServiceModel>();
    for (const m of seedModels()) models.set(m.model, m);
    g[MODELS_KEY] = { models, hydration: null };
  }
  return g[MODELS_KEY]!;
}

// Durable best-effort mirror: the in-process Map stays authoritative; every
// mutation writes through, and hydration merges persisted models back after a
// pod roll. An unreachable OpenSearch never throws into a request.
const mirror = osMirror({
  index: 'os-science-models',
  createBody: {
    mappings: {
      properties: {
        id: { type: 'keyword' },
        model: { type: 'keyword' },
        owner: { type: 'keyword' },
        domain: { type: 'keyword' },
        tier: { type: 'keyword' },
        buildState: { type: 'keyword' },
        archived: { type: 'boolean' },
        updatedAt: { type: 'date' },
        spec: { type: 'object', enabled: false },
        versions: { type: 'object', enabled: false },
        metrics: { type: 'object', enabled: false },
      },
    },
  },
});

/**
 * Await the one-shot hydration of persisted models into the in-process registry.
 * Routes call this before reading/mutating; `store()` also kicks it off in the
 * background so sync consumers (lineage, big bets, MCP discovery) converge.
 */
export function ensureModelsHydrated(): Promise<void> {
  const s = modelState();
  if (!s.hydration) {
    s.hydration = (async () => {
      const docs = (await mirror.hydrate(1000)) ?? [];
      for (const doc of docs as ServiceModel[]) {
        if (doc && doc.model && !s.models.has(doc.model)) s.models.set(doc.model, doc);
      }
    })();
  }
  return s.hydration;
}

function store(): Map<string, ServiceModel> {
  const s = modelState();
  if (!s.hydration) void ensureModelsHydrated(); // lazy background hydration
  return s.models;
}

/** Write a model into the registry AND through to the durable mirror. */
function persist(m: ServiceModel): ServiceModel {
  store().set(m.model, m);
  mirror.writeThrough(m.model, m);
  return m;
}

/**
 * UNSCOPED full registry — for SYSTEM / governed contexts only (the model's own
 * serve path, aggregate counts). It returns every domain's models including other
 * users' Personal-tier ones, so it must NEVER back a per-viewer tab. UI/tab
 * callers MUST use `listModelsForUser` so RLS is applied.
 */
export function listModels(): ServiceModel[] {
  return [...store().values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The viewer identity for model RLS — id + the domains they belong to. */
export type ModelViewer = { id: string; domains: string[] };

/**
 * RLS predicate mirroring `lib/artifacts.visibleToUser` for the model tier ladder:
 *   • Personal    → owner only (never leak another user's Personal model)
 *   • Domain      → members of the owning domain only (no cross-domain leak)
 *   • Marketplace → published cross-domain (discovery; any domain may see + import)
 */
function modelVisibleToUser(m: ServiceModel, viewer: ModelViewer): boolean {
  if (m.tier === 'Marketplace') return true;
  if (m.tier === 'Personal') return m.owner === viewer.id;
  return viewer.domains.includes(m.domain);
}

/**
 * RLS-scoped model list for a viewer — the SAFE variant for any tab/cockpit
 * surface. Returns the viewer's own Personal models + the Domain models of the
 * domains they belong to + Marketplace-published models, and nothing else.
 */
export function listModelsForUser(viewer: ModelViewer, opts: { includeArchived?: boolean } = {}): ServiceModel[] {
  return [...store().values()]
    .filter((m) => modelVisibleToUser(m, viewer))
    .filter((m) => opts.includeArchived || !m.archived)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getModel(model: string): ServiceModel | null {
  return store().get(model) ?? null;
}

/** Test/seed hook: register or replace a model in the in-process registry. */
export function upsertModel(m: ServiceModel): ServiceModel {
  persist(m);
  return m;
}

/** Reset the registry to seed — used by tests so each case starts clean. */
export function _resetModels(): void {
  const s = modelState();
  s.models = new Map();
  for (const m of seedModels()) s.models.set(m.model, m);
  s.hydration = null;
  mirror.__reset();
}

// --------------------------------------------------------------- create a model ---

function slugModel(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/(^_|_$)/g, '');
}

/** The fields a caller supplies when creating a model; the rest are derived. */
export type CreateModelInput = {
  name: string;
  description?: string;
  spec: ModelSpec;
};

/**
 * Register a NEW model as a `draft` artifact, owned by the actor in their domain
 * at the base `Personal` tier — the create seam the builder's Define step calls.
 * Mirrors how every other artifact is born: authored by a human (agents rejected),
 * scoped to a domain the actor belongs to, and persisted into the SAME in-process
 * registry every other store fn keys on (`upsertModel`), so the RLS list, the
 * policy compiler and the whole tier ladder apply to it immediately. Pure + in-
 * process (like the agents/dataset MOCK stores) so it stays `node --test`-safe.
 */
export function createModel(input: CreateModelInput, actor: Actor): ServiceModel {
  assertHuman(actor, 'create a model');
  const domain = actor.domains[0];
  if (!domain) throw withStatus(new Error('You must belong to a domain to create a model'), 403);
  const name = input.name?.trim();
  if (!name) throw withStatus(new Error('A model needs a name'), 400);
  const modelId = slugModel(name);
  if (!modelId) throw withStatus(new Error('The model name must contain letters or digits'), 400);
  if (getModel(modelId)) throw withStatus(new Error(`A model named ${modelId} already exists`), 409);

  const now = new Date().toISOString();
  const m: ServiceModel = {
    id: `svc_${modelId}`,
    model: modelId,
    name,
    owner: actor.id,
    domain,
    tier: 'Personal',
    stage: 'Staging',
    frontDoors: ['rest', 'mcp'],
    versions: [],
    spec: input.spec,
    buildState: 'draft',
    description: input.description?.trim() || undefined,
    kserveService: modelId,
    createdAt: now,
    updatedAt: now,
  };
  return upsertModel(m);
}

// ------------------------------------------------------------ train transitions ---

/**
 * A model-service can only be TRAINED by its owner (or an in-domain admin) — the
 * same edit-scope gate archive/delete use, plus the human invariant. Reused by the
 * train route before it submits the (least-privilege, run-as-user) training Job.
 */
export function assertCanTrain(model: string, actor: Actor): ServiceModel {
  const m = getModel(model);
  if (!m) throw withStatus(new Error(`unknown model ${model}`), 404);
  assertHuman(actor, 'train a model');
  requireEditScope(actor, m, 'train');
  if (!m.spec) throw withStatus(new Error('This model has no spec to train from — define it first'), 400);
  return m;
}

/**
 * Flip a model draft→training and stamp the submitted run handle. Guarded so a
 * second submit while a run is in flight is a typed 409 (never two Jobs racing the
 * same artifact). Returns the updated model.
 */
export function startTraining(model: string, actor: Actor, run: { jobName: string; namespace: string }): ServiceModel {
  const m = assertCanTrain(model, actor);
  if (m.buildState === 'training') throw withStatus(new Error('A training run is already in flight for this model'), 409);
  m.buildState = 'training';
  m.trainingJob = run.jobName;
  m.trainingNamespace = run.namespace;
  m.updatedAt = new Date().toISOString();
  persist(m);
  return m;
}

/**
 * Complete a training run: training→trained, register the new version and record
 * the run's metrics (from MLflow if the route resolved them; a placeholder value
 * otherwise so the version is honest about being untracked). Edit-scoped + human.
 */
export function completeTraining(
  model: string,
  actor: Actor,
  result: { runId: string; metric?: number; metricName?: string },
): ServiceModel {
  const m = getModel(model);
  if (!m) throw withStatus(new Error(`unknown model ${model}`), 404);
  assertHuman(actor, 'complete training');
  requireEditScope(actor, m, 'train');
  const version = `v${m.versions.length + 1}`;
  const metricName = result.metricName ?? m.spec?.optimizeMetric ?? 'metric';
  const value = typeof result.metric === 'number' ? result.metric : 0;
  m.versions.push({ version, stage: 'Staging', auc: value, certified: false, runId: result.runId });
  m.buildState = 'trained';
  m.mlflowRunId = result.runId;
  m.metrics = { primary: value, primaryMetric: metricName };
  m.trainingJob = undefined;
  m.trainingNamespace = undefined;
  m.updatedAt = new Date().toISOString();
  persist(m);
  return m;
}

/** Mark a training run failed (training→draft) so the owner can fix the spec + retry. */
export function failTraining(model: string, actor: Actor, reason: string): ServiceModel {
  const m = getModel(model);
  if (!m) throw withStatus(new Error(`unknown model ${model}`), 404);
  assertHuman(actor, 'fail training');
  requireEditScope(actor, m, 'train');
  m.buildState = 'draft';
  m.trainingJob = undefined;
  m.trainingNamespace = undefined;
  m.lastTrainingError = reason;
  m.updatedAt = new Date().toISOString();
  persist(m);
  return m;
}

// ----------------------------------------------------------- deploy transitions ---

/**
 * The deploy EDIT-SCOPE gate (owner / in-domain admin, human only) without state
 * checks — the poll path uses it so a `deploying` model can be read. 404 unknown.
 */
export function assertDeployScope(model: string, actor: Actor): ServiceModel {
  const m = getModel(model);
  if (!m) throw withStatus(new Error(`unknown model ${model}`), 404);
  assertHuman(actor, 'deploy a model');
  requireEditScope(actor, m, 'deploy');
  return m;
}

/**
 * A model can only be DEPLOYED by its owner (or an in-domain admin) — the same
 * edit-scope gate train uses — and only once TRAINED (there must be an uploaded
 * artifact at the model's storageUri). Re-deploy of a `deployed`/`deploy_failed`
 * model is allowed (idempotent reconcile); a `deploying`/`training` model is a
 * typed 409. The deploy route calls this BEFORE touching the cluster.
 */
export function assertCanDeploy(model: string, actor: Actor): ServiceModel {
  const m = assertDeployScope(model, actor);
  if (m.buildState === 'deploying') throw withStatus(new Error('A deploy is already in flight for this model'), 409);
  if (m.buildState === 'training') throw withStatus(new Error('Wait for the training run to finish before deploying'), 409);
  if (m.buildState !== 'trained' && m.buildState !== 'deployed' && m.buildState !== 'deploy_failed') {
    throw withStatus(new Error('Train the model first — deploy serves the trained artifact'), 400);
  }
  return m;
}

/** Flip trained/deploy_failed/deployed → deploying and stamp the InferenceService name. */
export function startDeploy(model: string, actor: Actor, isvc: string): ServiceModel {
  const m = assertCanDeploy(model, actor);
  m.buildState = 'deploying';
  m.kserveService = isvc;
  m.lastDeployError = undefined;
  m.updatedAt = new Date().toISOString();
  persist(m);
  return m;
}

/** Complete a deploy: deploying → deployed (the InferenceService reports Ready). */
export function completeDeploy(model: string, actor: Actor): ServiceModel {
  const m = getModel(model);
  if (!m) throw withStatus(new Error(`unknown model ${model}`), 404);
  assertHuman(actor, 'complete a deploy');
  requireEditScope(actor, m, 'deploy');
  m.buildState = 'deployed';
  m.lastDeployError = undefined;
  m.updatedAt = new Date().toISOString();
  persist(m);
  return m;
}

/** Mark a deploy failed (deploying → deploy_failed) with the honest cluster reason. */
export function failDeploy(model: string, actor: Actor, reason: string): ServiceModel {
  const m = getModel(model);
  if (!m) throw withStatus(new Error(`unknown model ${model}`), 404);
  assertHuman(actor, 'fail a deploy');
  requireEditScope(actor, m, 'deploy');
  m.buildState = 'deploy_failed';
  m.lastDeployError = reason;
  m.updatedAt = new Date().toISOString();
  persist(m);
  return m;
}

// --------------------------------------------------- The policy compiler (mirror) ---

/**
 * Compile the model's tier into the `predict` OPA data bundle shape. This is the
 * SINGLE source both front doors evaluate, so promoting/certifying the model is
 * the ONLY thing that changes callable scope — exactly the data/metrics ladder.
 */
export function compilePredictPolicy(m: ServiceModel): CompiledPredictPolicy {
  // The owner's model principal can always call its own service. The owner is
  // listed in BOTH principal forms (bare uid + the session `user:<id>` form the
  // MCP/UI doors authorize under) — same dual-form rule the OPA rego applies.
  const allowedPrincipals = [`${m.model.replace(/_/g, '-')}`, `${m.owner}`, `user:${m.owner}`];
  // Personal: owner only (no domain reach). Domain+: the owning domain may call.
  const allowedDomains = m.tier === 'Personal' ? [] : [m.domain];
  const crossDomain = m.tier === 'Marketplace';
  return {
    model: m.model,
    tier: m.tier,
    allowedPrincipals,
    allowedDomains,
    crossDomain,
    consumptionMode: m.consumptionMode,
  };
}

/**
 * Evaluate a compiled policy against a caller — the Rego the OPA bundle encodes.
 * Tier scope decides reach; whether the principal is granted the `predict` tool
 * is a SEPARATE check done by `authorizePredict()` (consults live OPA first).
 *   • principal explicitly allowed → in scope
 *   • caller's domain is within the model's allowed domains → in scope
 *   • Marketplace tier (crossDomain) → in scope (any domain may call once imported)
 */
export function inCallableScope(policy: CompiledPredictPolicy, caller: Caller): boolean {
  if (policy.allowedPrincipals.includes(caller.principal)) return true;
  // The caller must actually BELONG to an allowed domain (session-derived) — a
  // body-supplied domain can no longer forge reach into another domain's model.
  if (policy.allowedDomains.some((d) => caller.domains.includes(d))) return true;
  if (policy.crossDomain) return true;
  return false;
}

// ----------------------------------------------------- The governed predict gate ---

export type PredictAuthz = {
  decision: 'allow' | 'deny' | 'requires_approval';
  /** Which front door this decision is for (audit + UI). */
  frontDoor: 'rest' | 'mcp';
  /** Why — the tier-scope reason or the OPA tool reason. */
  reason: string;
  /** The compiled policy that produced the decision (proves no REST/MCP drift). */
  policy: CompiledPredictPolicy;
  /** The OPA tool decision marker (opa-allow / opa-deny / opa-unreachable / …). */
  toolPolicy: string;
};

/** The OPA `predict`-tool authorizer; injectable so the spine is unit-testable. */
export type ToolAuthorizer = (principal: string) => Promise<Authz>;

/** Default: the live OPA decision via the agent-tool spine (dynamic so node tests skip it). */
async function defaultToolAuthorizer(principal: string): Promise<Authz> {
  const { authorize } = await import('@/lib/infra/agent-governed');
  return authorize(principal, 'predict');
}

/**
 * THE governed gate for a `predict` call through either front door. Two AND-ed
 * checks, identical for REST and MCP:
 *
 *   1. Tier scope — is the caller within the model's compiled callable scope?
 *      (Promoting/certifying the model widens this; nothing else does.)
 *   2. Tool grant — does OPA grant this principal the `predict` tool? (live OPA
 *      first, offline mirror when OPA is down — `agent-governed.authorize`).
 *
 * Out-of-scope ⇒ deny (tier). Granted-but-requires-approval ⇒ requires_approval.
 * In scope + granted ⇒ allow. The caller (route) is responsible for the Langfuse
 * trace; this function only decides.
 */
export async function authorizePredict(
  model: string,
  caller: Caller,
  authorizeTool: ToolAuthorizer = defaultToolAuthorizer,
): Promise<PredictAuthz> {
  await ensureModelsHydrated(); // durable registry: never deny on a cold cache
  const m = getModel(model);
  const frontDoor: 'rest' | 'mcp' = caller.isAgent ? 'mcp' : 'rest';
  if (!m) {
    const empty: CompiledPredictPolicy = {
      model,
      tier: 'Personal',
      allowedPrincipals: [],
      allowedDomains: [],
      crossDomain: false,
    };
    return { decision: 'deny', frontDoor, reason: `unknown model ${model}`, policy: empty, toolPolicy: 'opa-deny' };
  }
  const policy = compilePredictPolicy(m);

  // 1. Tier scope — the visibility ladder boundary.
  if (!inCallableScope(policy, caller)) {
    return {
      decision: 'deny',
      frontDoor,
      reason:
        `${caller.principal} (domains ${caller.domains.join(', ') || 'none'}) is outside the ${m.tier} callable scope of ${model}` +
        ` — promote/certify the model to widen who can call it`,
      policy,
      toolPolicy: 'tier-scope-deny',
    };
  }

  // 2. Tool grant — the same OPA `predict` authorization every governed tool uses.
  // EXCEPTION (self-consumption): the OWNER calling their OWN model needs no
  // third-party tool grant — the compiled policy already names them. The grant
  // check governs OTHER principals (agents, apps, in-domain users).
  if (caller.principal === m.owner || caller.principal === `user:${m.owner}`) {
    return { decision: 'allow', frontDoor, reason: 'owner self-consumption of their own model', policy, toolPolicy: 'owner-self' };
  }
  const authz = await authorizeTool(caller.principal);
  if (authz.effect === 'deny') {
    return { decision: 'deny', frontDoor, reason: authz.reason, policy, toolPolicy: authz.policy };
  }
  if (authz.effect === 'requires_approval') {
    return { decision: 'requires_approval', frontDoor, reason: authz.reason, policy, toolPolicy: authz.policy };
  }
  return { decision: 'allow', frontDoor, reason: 'in scope + granted predict', policy, toolPolicy: authz.policy };
}

// ------------------------------------------------------- Lifecycle transitions ---

const ORDER: ModelTier[] = ['Personal', 'Domain', 'Marketplace'];

/** The hard invariant: an agent can never drive a certify / go-live / promote. */
function assertHuman(actor: Actor, action: string): void {
  if (actor.isAgent) {
    throw withStatus(
      new Error(`An agent cannot ${action} — certify, go-live, and promotion are always a human Builder/Admin`),
      403,
    );
  }
}

function requireDomain(actor: Actor, m: ServiceModel): void {
  if (!actor.domains.includes(m.domain)) {
    throw withStatus(new Error(`You can only act on models in a domain you belong to (${m.domain})`), 403);
  }
}

/**
 * Promote Personal → Domain. Builder/Admin gate; widens callable scope to the
 * whole owning domain via `compilePredictPolicy`. Agents are rejected.
 */
export function promoteModel(model: string, actor: Actor): ServiceModel {
  const m = getModel(model);
  if (!m) throw withStatus(new Error(`unknown model ${model}`), 404);
  assertHuman(actor, 'promote a model');
  requireDomain(actor, m);
  if (m.tier !== 'Personal') throw withStatus(new Error(`model is already ${m.tier}; use certify for Marketplace`), 400);
  if (actor.role === 'user') {
    throw withStatus(new Error('Promoting to Domain requires a Builder, Domain admin, or Admin'), 403);
  }
  m.tier = 'Domain';
  persist(m);
  return m;
}

/**
 * Go-live: transition the certified Production version live (Staging→Production).
 * Builder/Admin gate; agents rejected. (Stage and tier are orthogonal: a model
 * can be Production-staged while still Personal-tier; go-live is the stage move.)
 */
export function goLive(model: string, actor: Actor): ServiceModel {
  const m = getModel(model);
  if (!m) throw withStatus(new Error(`unknown model ${model}`), 404);
  assertHuman(actor, 'approve go-live');
  requireDomain(actor, m);
  if (actor.role === 'user') {
    throw withStatus(new Error('Go-live to Production requires a Builder, Domain admin, or Admin'), 403);
  }
  const staging = m.versions.find((v) => v.stage === 'Staging');
  if (staging) {
    for (const v of m.versions) if (v.stage === 'Production') v.stage = 'Archived';
    staging.stage = 'Production';
    staging.certified = true;
  }
  m.stage = 'Production';
  persist(m);
  return m;
}

/**
 * Certify Domain → Marketplace. ADMIN gate; the owner sets the consumption mode
 * (read-in-place default, or fork-allowed) AT this moment, per artifact. Agents
 * rejected. Certification widens callable scope cross-domain automatically.
 */
export function certifyModel(model: string, actor: Actor, mode: ConsumptionMode): ServiceModel {
  const m = getModel(model);
  if (!m) throw withStatus(new Error(`unknown model ${model}`), 404);
  assertHuman(actor, 'certify a model');
  requireDomain(actor, m);
  if (actor.role !== 'admin') {
    throw withStatus(new Error('Certifying to the Marketplace requires an Admin'), 403);
  }
  if (m.tier === 'Personal') {
    throw withStatus(new Error('Promote the model to Domain before certifying to the Marketplace'), 400);
  }
  m.tier = 'Marketplace';
  m.consumptionMode = mode;
  persist(m);
  return m;
}

/** The next tier a human could move the model to, or null at the top. */
export function nextTier(t: ModelTier): ModelTier | null {
  const i = ORDER.indexOf(t);
  return i >= 0 && i < ORDER.length - 1 ? ORDER[i + 1] : null;
}

/** Edit-scope for archive/delete: the owner, a domain_admin of the owning domain,
 *  or a platform Admin — the ONE fail-closed rule shared with every other tab. */
function requireEditScope(actor: Actor, m: ServiceModel, action: string): void {
  requireDomain(actor, m);
  // Map the science Actor role onto the session Role for the shared gate:
  // 'user' has no manage rights (→ creator); builder/domain_admin/admin pass through.
  const role = actor.role === 'user' ? 'creator' : actor.role;
  // A Personal-tier model is owner-only; a shared/marketplace model admits an in-
  // domain domain_admin or a platform admin.
  const scope: ArtifactScope = m.tier === 'Personal' ? 'personal' : m.tier === 'Marketplace' ? 'certified' : 'shared';
  if (!canManageArtifact({ id: actor.id, role, domains: actor.domains }, { owner: m.owner, domain: m.domain, scope })) {
    throw withStatus(new Error(`Only the owner, an in-domain Domain admin, or an Admin can ${action} this model`), 403);
  }
}

/**
 * Archive / restore a model (the OS-wide lifecycle). Archived models drop out of
 * the tab list until restored; delete is reachable only once archived. Edit-scoped
 * (owner or domain Admin), agents rejected — the same authz posture as promote.
 */
export function setModelArchived(model: string, actor: Actor, archived: boolean): ServiceModel {
  const m = getModel(model);
  if (!m) throw withStatus(new Error(`unknown model ${model}`), 404);
  assertHuman(actor, archived ? 'archive a model' : 'restore a model');
  requireEditScope(actor, m, archived ? 'archive' : 'restore');
  m.archived = archived;
  persist(m);
  return m;
}

/**
 * Physically delete a model — remove it from the registry (the record every store
 * fn keys on). Edit-scoped, agents rejected, and ONLY once archived (mirrors the
 * OS-wide "delete archived-only" rule the UI also enforces). Returns the removed
 * record so the route can report the backing teardown honestly.
 */
export function deleteModel(model: string, actor: Actor): ServiceModel {
  const m = getModel(model);
  if (!m) throw withStatus(new Error(`unknown model ${model}`), 404);
  assertHuman(actor, 'delete a model');
  requireEditScope(actor, m, 'delete');
  if (!m.archived) throw withStatus(new Error('Archive the model before deleting it'), 400);
  store().delete(m.model);
  mirror.deleteThrough(m.model);
  return m;
}
