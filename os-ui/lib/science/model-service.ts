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
  LaunchStatus,
  LaunchStep,
  LaunchStepState,
  ModelSpec,
  ModelSpecInput,
  ModelTier,
  ModelUsage,
  ServiceModel,
  TaskType,
} from '@/lib/science/types';
// Pure edit-scope helper (type-only dep chain — safe under `node --test`).
import { canManageArtifact, type ArtifactScope } from '../governance/edit-scope.ts';
// Durable best-effort mirror (relative import — node-test-safe, no `@/` value chain).
import { osMirror } from '../infra/os-mirror.ts';
// The pure folder-path normaliser + the governed folder registry (Wave-2 parity):
// a moved-into folder is upserted as an explicit row so it persists even when empty.
// Reused, never forked (mirrors lib/data/store.ts). All relative → node-test-safe.
import { normaliseFolderPath } from '../core/folders.ts';
import { createFolder, type Principal as FolderPrincipal } from '../folders/index.ts';

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
 *      Admin. An agent actor is rejected by `assertHuman()` — an agent proposes,
 *      a human ships.
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
 * A fresh tenant starts EMPTY. Models are registered only through the builder's
 * Define → Train & launch flow (or the platform's own promote/certify flows, e.g.
 * the Northpeak e-commerce seed). There is NO fabricated seed model: the removed
 * churn seed used to plant invented facts (auc 0.871, runId 'mlf-run-2a9c') a fresh
 * tenant never earned — an honesty violation. Existing tenants that already persisted
 * the seed keep their record (no migration); this only stops CREATING new ones.
 */
function seedModels(): ServiceModel[] {
  return [];
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
        folder: { type: 'keyword' },
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
 * Cross-domain governance move (admin-only, gated in lib/platform-admin/domain-move.ts).
 * A model's identity is its `model` key; scoping reads its `domain` field, so we
 * set it and persist. `sel.id` matches the model key; `sel.onlyUnassigned` sweeps
 * only empty-domain records. Returns the model keys moved.
 */
export function moveModelsDomain(sel: { id?: string; onlyUnassigned?: boolean }, target: string): string[] {
  const moved: string[] = [];
  for (const m of store().values()) {
    if (sel.id !== undefined && m.model !== sel.id) continue;
    if (sel.onlyUnassigned && m.domain) continue;
    if (m.domain === target) continue;
    m.domain = target;
    persist(m);
    moved.push(m.model);
  }
  return moved;
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
 * RLS predicate for the model tier ladder under STRICT DOMAIN ISOLATION — EVERY tier
 * narrows to the viewer's live (active) domain scope:
 *   • Personal    → owner only AND domain must be in the viewer's live scope
 *   • Domain      → members of the owning domain only (no cross-domain leak)
 *   • Marketplace → this tab's "Company" tier: the owning domain only (a certified
 *     model homed in domain A must NOT show while acting in domain B). Cross-domain
 *     discovery + import is the dedicated Marketplace catalog's job, not this list's.
 *
 * auth.ts narrows viewer.domains to [active] when a domain is chosen, so each tier
 * filters to it; "All Domains" keeps every membership so all show. A domainless model
 * always shows (the admin assigns it via the domain-move tool).
 */
function modelVisibleToUser(m: ServiceModel, viewer: ModelViewer): boolean {
  const inScope = !m.domain || viewer.domains.includes(m.domain);
  if (m.tier === 'Marketplace') return inScope;
  if (m.tier === 'Domain') return inScope;
  // Personal: owner only, AND domain must be in the caller's live scope.
  return m.owner === viewer.id && inScope;
}

/**
 * RLS-scoped model list for a viewer — the SAFE variant for any tab/cockpit
 * surface. Returns the viewer's own Personal models (in-scope domain) + the Domain
 * models of the domains they belong to + Marketplace-published models, and nothing
 * else.
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
  /** Simple-mode: `algorithm`/`optimizeMetric`/`trainTestSplit` may be omitted (server fills defaults). */
  spec: ModelSpecInput;
};

/**
 * The learners the training runtime can ACTUALLY train, per task. This is the honest
 * supported set — a caller who asks for anything else is REFUSED by name, never silently
 * given a different learner (the old `resolveAlgorithm` quietly trained logistic when the
 * user typed "xgboost" — an honesty violation this replaces). Keep in lockstep with the
 * trainer image's real capabilities.
 */
const SUPPORTED_ALGORITHMS: Record<TaskType, string[]> = {
  binary_classification: ['logistic'],
  multiclass_classification: ['logistic'],
  regression: ['linear'],
  forecast: ['linear'],
  clustering: ['kmeans'],
};

/**
 * The metrics that make sense for each task family — the honest metric↔task pairing the trainer
 * can actually compute. A classification metric (auc/f1/…) on a REGRESSION run is a category error
 * (there is no ROC curve for a continuous target); a regression metric (rmse/…) on a CLASSIFICATION
 * run is likewise wrong. Enforced by {@link normalizeSpec} so a mismatched request is refused up
 * front (400) rather than silently degraded to the wrong number by the trainer's `score()` fallback.
 *
 * NOTE: the deeper check — that the TARGET COLUMN's dtype matches the task (e.g. rejecting
 * classification on a continuous `duration_days`) — needs the column dtype, which is only available
 * at the Design/assistant grounding layer (datasetColumnsTyped), not in this pure node-test-safe
 * spine. That dtype-aware guard is deferred to the grounding layer; here we enforce the metric↔task
 * consistency that IS decidable from the spec alone.
 */
const TASK_METRICS: Record<TaskType, string[]> = {
  binary_classification: ['auc', 'roc_auc', 'f1', 'accuracy'],
  multiclass_classification: ['f1', 'accuracy'],
  regression: ['rmse', 'mae', 'mse', 'r2'],
  forecast: ['rmse', 'mae', 'mse', 'r2'],
  clustering: ['silhouette'],
};

/** The default learner + optimize metric for a task (the real learner the trainer runs). */
function taskDefaults(task: TaskType): { algorithm: string; optimizeMetric: string } {
  switch (task) {
    case 'binary_classification':
    case 'multiclass_classification':
      return { algorithm: 'logistic', optimizeMetric: 'auc' };
    case 'regression':
    case 'forecast':
      return { algorithm: 'linear', optimizeMetric: 'rmse' };
    case 'clustering':
      return { algorithm: 'kmeans', optimizeMetric: 'silhouette' };
  }
}

/**
 * Fill Simple-mode defaults into a spec and VALIDATE the learner honestly. `algorithm`,
 * `optimizeMetric` and `trainTestSplit` default per task when omitted; a supplied algorithm
 * the runtime cannot train is REFUSED (400) naming the supported set — NEVER substituted.
 * Exported so the create route (and tests) can normalize the same way.
 */
export function normalizeSpec(input: ModelSpecInput): ModelSpec {
  const task = input.taskType;
  const defaults = taskDefaults(task);
  const supported = SUPPORTED_ALGORITHMS[task];
  const algorithm = input.algorithm?.trim() || defaults.algorithm;
  if (!supported.includes(algorithm)) {
    throw withStatus(
      new Error(
        `Algorithm "${algorithm}" is not supported for ${task}. Supported: ${supported.join(', ')}. ` +
          `Pick a supported learner (or omit it to use the default "${defaults.algorithm}").`,
      ),
      400,
    );
  }
  const split = typeof input.trainTestSplit === 'number' ? input.trainTestSplit : 0.8;
  if (!(split > 0 && split < 1)) {
    throw withStatus(new Error('trainTestSplit must be a fraction in (0,1)'), 400);
  }
  // Metric↔task consistency: a classification metric (auc/…) on a regression run — or vice versa —
  // is refused by name, never silently degraded (the trainer's score() would otherwise fall back to
  // the wrong metric, e.g. auc→accuracy on a mislabeled continuous target). Omit it to get the
  // task's honest default.
  const optimizeMetric = input.optimizeMetric?.trim().toLowerCase() || defaults.optimizeMetric;
  const okMetrics = TASK_METRICS[task];
  if (!okMetrics.includes(optimizeMetric)) {
    throw withStatus(
      new Error(
        `Metric "${optimizeMetric}" does not apply to a ${task} model. Valid: ${okMetrics.join(', ')}. ` +
          `(auc/f1 are classification metrics; rmse/mae/r2 are regression metrics — pick the task that matches ` +
          `your target, e.g. use regression for a continuous target, or omit the metric to use "${defaults.optimizeMetric}".)`,
      ),
      400,
    );
  }
  return {
    sourceDataProductFqn: input.sourceDataProductFqn,
    sourceDatasetId: input.sourceDatasetId,
    targetColumn: input.targetColumn,
    taskType: task,
    algorithm,
    features: input.features,
    trainTestSplit: split,
    optimizeMetric,
  };
}

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
  // Simple-mode: fill task defaults + REFUSE an unsupported algorithm (never substitute).
  const spec = normalizeSpec(input.spec);

  const now = new Date().toISOString();
  const m: ServiceModel = {
    id: `svc_${modelId}`,
    model: modelId,
    name,
    owner: actor.id,
    domain,
    tier: 'Personal',
    stage: 'Staging',
    folder: '/',
    frontDoors: ['rest', 'mcp'],
    versions: [],
    spec,
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
  // Metric-NAME-correct version: carry both the value AND its real name (auc / rmse / …),
  // so a regression version reads "rmse 12.3" not a mislabeled AUC. `auc` is the deprecated
  // back-compat mirror of the value (Phase B removes it) — never a fabricated number.
  m.versions.push({ version, stage: 'Staging', metric: value, metricName, auc: value, certified: false, runId: result.runId });
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

// -------------------------------------------------- Fused "Train & launch" status ---

const LAUNCH_LABELS: Record<LaunchStep['key'], string> = {
  read: 'Reading data',
  train: 'Training',
  publish: 'Publishing',
};

/** One step, with its state + real detail. */
function step(key: LaunchStep['key'], state: LaunchStepState, detail?: string): LaunchStep {
  return { key, label: LAUNCH_LABELS[key], state, detail };
}

/**
 * Derive the coherent fused Train & launch status a timeline renders, PURELY from the model's
 * `buildState` + its in-flight handles. "Read" and "Train" are ONE training Job (the runner reads
 * the governed Gold product through Trino, then fits) so they advance together; "Publish" is the
 * deploy. `phaseDetail` (optional) is the live poll detail (job phase / ISVC reason) the route
 * threads in for the Developer view. This is a mapping, not a mutation — safe to call on any read.
 */
export function computeLaunchStatus(m: ServiceModel, phaseDetail?: string): LaunchStatus {
  const bs = m.buildState ?? 'draft';
  const jobDetail = m.trainingJob ? `job ${m.trainingJob}` : undefined;
  const isvcDetail = m.kserveService ? `InferenceService ${m.kserveService}` : undefined;
  let steps: LaunchStep[];
  switch (bs) {
    case 'draft':
      steps = [step('read', 'pending'), step('train', 'pending'), step('publish', 'pending')];
      break;
    case 'training':
      steps = [
        step('read', 'done'),
        step('train', 'running', phaseDetail ?? jobDetail),
        step('publish', 'pending'),
      ];
      break;
    case 'trained':
      // Trained but not yet publishing — in the fused flow this is a transient handoff.
      steps = [step('read', 'done'), step('train', 'done'), step('publish', 'pending')];
      break;
    case 'deploying':
      steps = [step('read', 'done'), step('train', 'done'), step('publish', 'running', phaseDetail ?? isvcDetail)];
      break;
    case 'deployed':
      steps = [step('read', 'done'), step('train', 'done'), step('publish', 'done', isvcDetail)];
      break;
    case 'deploy_failed':
      steps = [step('read', 'done'), step('train', 'done'), step('publish', 'failed', m.lastDeployError)];
      break;
    case 'archived':
      steps = [step('read', 'done'), step('train', 'done'), step('publish', 'done')];
      break;
  }
  // A failed training run resets to draft with lastTrainingError set — surface it on the train step.
  if (bs === 'draft' && m.lastTrainingError) {
    steps = [step('read', 'done'), step('train', 'failed', m.lastTrainingError), step('publish', 'pending')];
  }
  const error =
    bs === 'deploy_failed' ? m.lastDeployError : steps.some((s) => s.key === 'train' && s.state === 'failed') ? m.lastTrainingError : undefined;
  return { phase: bs, launched: bs === 'deployed', steps, error };
}

// --------------------------------------------------------------- Usage recording ---

/** Local YYYY-MM-DD day key for a bucket (the histogram's time axis). */
function dayKey(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** The band key for a scored ALLOWED call: score deciles for classification, coarse
 *  value bands otherwise. Deciles clamp to d0..d9; value bands hash the value into b0..b9. */
function bandKey(kind: ModelUsage['bandKind'], score: number): string {
  if (kind === 'decile') {
    const d = Math.min(9, Math.max(0, Math.floor(score * 10)));
    return `d${d}`;
  }
  // value-band: split the value across b0..b9 by its integer-ish magnitude (no fabricated range —
  // just a stable coarse bucketing; a real range calibration is Phase-B chart work).
  const b = Math.min(9, Math.max(0, Math.floor(Math.abs(score) % 10)));
  return `b${b}`;
}

/**
 * Record ONE predict against a model's durable usage — called on EVERY predict (allow AND deny).
 * Cheap + real: bumps `count`, `denied` (when denied), `lastCalledAt`, and (for an ALLOWED, scored
 * call) the day×band histogram. Persists through the same registry write-through the model uses, so
 * usage survives a pod roll. A denied/unscored call still counts (so the count is honest) but does
 * not touch the score histogram. Unknown model → no-op (nothing to attribute usage to).
 */
export function recordUsage(
  model: string,
  ev: { allowed: boolean; score?: number; taskType?: TaskType; at?: Date },
): ServiceModel | null {
  const m = getModel(model);
  if (!m) return null;
  const at = ev.at ?? new Date();
  const bandKind: ModelUsage['bandKind'] =
    (ev.taskType ?? m.spec?.taskType) === 'regression' || (ev.taskType ?? m.spec?.taskType) === 'forecast'
      ? 'value-band'
      : 'decile';
  const u: ModelUsage = m.usage ?? { count: 0, denied: 0, bandKind, buckets: {} };
  // Keep bandKind consistent with the model's current task (first write wins the scheme).
  u.count += 1;
  if (!ev.allowed) u.denied += 1;
  u.lastCalledAt = at.toISOString();
  if (ev.allowed && typeof ev.score === 'number' && Number.isFinite(ev.score)) {
    const day = dayKey(at);
    const key = bandKey(u.bandKind, ev.score);
    const dayBuckets = (u.buckets[day] ??= {});
    dayBuckets[key] = (dayBuckets[key] ?? 0) + 1;
  }
  m.usage = u;
  m.updatedAt = at.toISOString();
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

/**
 * Demotion (revoke sharing) — the reverse of promote/certify, one step down:
 *   Marketplace ──(Admin)──▶ Domain ──(owner | in-domain Domain admin | Admin)──▶ Personal
 * Mirrors the OS-wide demote rule (agents/dashboards): revoking a certification is
 * Admin-only (only an Admin certified it); unsharing is the manage scope. Lowering
 * the tier narrows who may call `predict` automatically via the compiled policy —
 * the model itself is never deleted.
 */
export function demoteModel(model: string, actor: Actor): ServiceModel {
  const m = getModel(model);
  if (!m) throw withStatus(new Error(`unknown model ${model}`), 404);
  assertHuman(actor, 'revoke sharing on a model');
  requireDomain(actor, m);
  if (m.tier === 'Marketplace') {
    if (actor.role !== 'admin') throw withStatus(new Error('Revoking a model from the Marketplace requires an Admin'), 403);
    m.tier = 'Domain';
    delete m.consumptionMode;
  } else if (m.tier === 'Domain') {
    requireEditScope(actor, m, 'unshare');
    m.tier = 'Personal';
  } else {
    throw withStatus(new Error('This model is already personal — nothing to revoke'), 400);
  }
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

// -------------------------------------------------------------- rename / folder ---

/**
 * Rename a model — change its DISPLAY `name` ONLY. Edit-scoped exactly like every other
 * mutation (owner always; an in-domain domain_admin / platform admin on a shared/certified
 * model — the reused edit-scope gate, never an exact role set), agents rejected.
 *
 * CRITICAL — the SERVING IDENTITY never moves. `m.model` (the KServe InferenceService +
 * OPA `predict` tool identity + the registry key + FQN/policy-principal source) is the
 * dataset-slug-freeze equivalent: it was slugged from the ORIGINAL name ONCE at
 * {@link createModel} (`slugModel(name)`) and STORED, so it is ALREADY frozen. This is
 * why — unlike `renameDataset`, which must PIN a slug before the name changes — we do
 * NOT re-derive anything here: we set `m.name` and leave `m.model` (and `kserveService`)
 * untouched, so no live serving endpoint, policy principal or FQN is ever orphaned.
 *
 * The create-time model-id uniqueness (`createModel` 409s a duplicate slug) is therefore
 * preserved automatically: a rename never re-runs `slugModel`, so it can never re-collide
 * `model`. Trim + reject-empty (400) + no-op short-circuit (no churn), matching renameDataset.
 *
 * NOTE: Science has NO per-artifact version log (unlike `lib/data/store.ts`, which snapshots
 * dataset.yaml on rename), so there is no history snapshot to take here — the durable mirror
 * write-through IS the persistence. If a versionLog is added to Science later, snapshot here.
 */
export function renameModel(model: string, actor: Actor, newName: string): ServiceModel {
  const m = getModel(model);
  if (!m) throw withStatus(new Error(`unknown model ${model}`), 404);
  assertHuman(actor, 'rename a model');
  requireEditScope(actor, m, 'rename');
  const name = newName?.trim();
  if (!name) throw withStatus(new Error('A model needs a name'), 400);
  if (name === m.name) return m; // no-op → no churn (and `model` stays frozen regardless)
  // DISPLAY name only. `m.model` (serving/deploy/registry key) is intentionally NOT touched.
  m.name = name;
  m.updatedAt = new Date().toISOString();
  return persist(m);
}

/**
 * Move a model into a folder (edit-scoped, write-through like every other mutation).
 * Mirrors `lib/data/store.moveDataset`: the folder is a normalised path on the model,
 * and on move we ALSO upsert an EXPLICIT folder row in the governed registry so the
 * destination folder persists even when it holds no models. A caller who cannot edit is
 * rejected 403 and nothing is written. Models are domain-scoped, so the folder row is
 * always upserted under the owning DOMAIN's tree (scope `'domain'`).
 */
export function moveModel(model: string, actor: Actor, folder: string): ServiceModel {
  const m = getModel(model);
  if (!m) throw withStatus(new Error(`unknown model ${model}`), 404);
  assertHuman(actor, 'move a model');
  requireEditScope(actor, m, 'move');
  m.folder = normaliseFolderPath(folder);
  m.updatedAt = new Date().toISOString();
  persist(m);
  // The move already passed the model's edit-scope gate above, so this same-domain
  // folder create can only mirror an authorised move (best-effort; never rolls it back).
  upsertFolderRow(m, actor);
  return m;
}

/** Best-effort: mirror a model's folder path into the governed folder registry so an
 *  empty folder still shows in the rail. The root is implicit (never a row). createFolder
 *  is idempotent + edit-scoped; any gate failure is swallowed so a successful move is never
 *  rolled back by a folder-registry hiccup (mirrors lib/data/store.upsertFolderRow). Models
 *  are domain-scoped, so folders always live in the owning DOMAIN's tree. */
function upsertFolderRow(m: ServiceModel, actor: Actor): void {
  const path = normaliseFolderPath(m.folder ?? '/');
  if (path === '/') return;
  // Map the science Actor role onto the folder Principal role (creator floor for 'user').
  const role = actor.role === 'user' ? 'creator' : actor.role;
  const principal: FolderPrincipal = { id: actor.id, role, domains: actor.domains };
  try {
    createFolder(principal, { tab: 'science', scope: 'domain', path, domain: m.domain });
  } catch {
    /* folder-registry mirror is best-effort; the model move already succeeded */
  }
}
