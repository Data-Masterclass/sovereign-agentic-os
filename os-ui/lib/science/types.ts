/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Science (Layer 4 / ML) shared types — PURE types only (no secrets, no server
 * imports) so both client components and server routes can import them. The
 * server logic lives in the `server-only` siblings (`model-service.ts`,
 * `marketplace.ts`, `adapters.ts`).
 *
 * The spine these types describe is "model-as-service, tier-gated": a deployed
 * KServe model is exposed two ways from ONE endpoint — a governed REST `predict`
 * API (Software apps / external) and a governed `predict` MCP tool (agents) —
 * and WHO may call either is governed by the SAME visibility ladder that governs
 * data, metrics, and every other artifact:
 *
 *   Personal ──(Builder promote)──▶ Domain ──(Admin certify)──▶ Marketplace
 *
 * Promoting / certifying the model AUTOMATICALLY widens who can call its
 * API/MCP via the policy compiler → OPA. There is no separate "publish" step.
 */

/** Model-as-service visibility tier — mirrors the artifact Personal/Shared/Certified ladder. */
export type ModelTier = 'Personal' | 'Domain' | 'Marketplace';

/** MLflow-style registry stage. Go-live = Staging→Production (always a Builder). */
export type ModelStage = 'Staging' | 'Production' | 'Archived';

/** The two front doors a deployed model is exposed through (same endpoint, same governance). */
export type FrontDoor = 'rest' | 'mcp';

/** Marketplace consumption mode the owner sets at certify time, per artifact. */
export type ConsumptionMode = 'read-in-place' | 'fork-allowed';

export type ModelVersion = {
  version: string;
  stage: ModelStage;
  /** The primary metric's VALUE for this version (e.g. 0.871 for auc, 12.3 for rmse). */
  metric: number;
  /** WHICH metric `metric` is — mirrors `spec.optimizeMetric` (auc / rmse / f1 …). So a
   *  regression version reads "rmse 12.3", never a mislabeled "AUC". */
  metricName: string;
  /**
   * @deprecated Use `metric` + `metricName`. Kept during Phase A only so the current UI,
   * which still reads `.auc`, does not break. For a non-classification version this equals
   * `metric` (the primary value) but the label is WRONG — read `metricName` for the label.
   * Phase B removes this field.
   */
  auc: number;
  certified: boolean;
  runId: string;
};

/**
 * What KIND of learning problem a model solves — set once when the model is
 * created (the Define step of the builder), drives the metric a run optimizes and
 * the shape of a `predict` result. Additive: existing (seed) models default to the
 * churn task (`binary_classification`).
 */
export type TaskType =
  | 'binary_classification'
  | 'multiclass_classification'
  | 'regression'
  | 'forecast'
  | 'clustering';

/**
 * The build-time SPECIFICATION of a model — the "what to learn from what" captured
 * at create time and carried through train/deploy. Pure data (no secrets); the
 * source is referenced by its governed FQN/id, never by raw credentials.
 */
export type ModelSpec = {
  /** The governed data product the training data comes from, e.g. `sales.customer_360`. */
  sourceDataProductFqn: string;
  /** The specific dataset id under that product (optional until picked). */
  sourceDatasetId?: string;
  /** The label column to predict; null for unsupervised tasks (clustering). */
  targetColumn: string | null;
  taskType: TaskType;
  /** The learner, e.g. `logistic`, `linear`, `kmeans`. */
  algorithm: string;
  /** The input feature columns/feature-set members. */
  features: string[];
  /** Train/test split fraction in (0,1) — the share used for training. */
  trainTestSplit: number;
  /** The metric a run optimizes for, e.g. `auc`, `rmse`, `f1`. */
  optimizeMetric: string;
};

/**
 * The Simple-mode create input for a spec: everything the builder MUST know (the
 * source, target and task) is required, but the three tuning knobs — `algorithm`,
 * `optimizeMetric`, `trainTestSplit` — are OPTIONAL. When omitted the server fills
 * honest task defaults (`normalizeSpec`), so "Train & launch" needs no tuning. A
 * supplied `algorithm` the runtime cannot actually train is REFUSED (never silently
 * substituted).
 */
export type ModelSpecInput = Omit<ModelSpec, 'algorithm' | 'optimizeMetric' | 'trainTestSplit'> & {
  algorithm?: string;
  optimizeMetric?: string;
  trainTestSplit?: number;
};

/**
 * The MLOps build lifecycle of a model — orthogonal to the visibility `tier` and
 * the registry `stage`: `draft` (just created) → `training` → `trained` →
 * `deploying` → `deployed` (serving), with `deploy_failed` and `archived` as the
 * off-path states. `deployed` is terminal-live; monitoring rides on the deployed
 * model (real usage + ISVC readiness), so there is no separate `monitored` state.
 */
export type ModelBuildState =
  | 'draft'
  | 'training'
  | 'trained'
  | 'deploying'
  | 'deploy_failed'
  | 'deployed'
  | 'archived';

/** Headline evaluation metrics for the current version (nullable until trained). */
export type ModelMetrics = {
  /** The optimized metric's value, e.g. AUC 0.871. */
  primary?: number;
  /** Which metric `primary` is (mirrors `spec.optimizeMetric`). */
  primaryMetric?: string;
  /** Optional secondary metrics keyed by name (precision, recall, rmse, …). */
  secondary?: Record<string, number>;
};

/** A Featureform feature row (offline=Iceberg, online=Valkey) — shared by churn + adapters. */
export type FeatureRow = { name: string; entity: string; offline: string; online: string };

// ------------------------------------------------------- Fused "Train & launch" ---

/** One step's state in the fused Train & launch timeline. */
export type LaunchStepState = 'pending' | 'running' | 'done' | 'failed';

/**
 * ONE step of the fused Train & launch timeline (Simple: "Train & launch" is a single
 * action that reads → trains → publishes). Each step carries its coarse `state` (for the
 * Simple timeline) plus the REAL underlying `detail` (job name, ISVC status) the Developer
 * view surfaces. Phase B renders this verbatim.
 */
export type LaunchStep = {
  /** Stable key the UI maps to an icon/label. */
  key: 'read' | 'train' | 'publish';
  /** Human label for the Simple timeline (e.g. "Reading data", "Training", "Publishing"). */
  label: string;
  state: LaunchStepState;
  /** The real underlying detail — job name / ISVC phase+reason — for the Developer view. */
  detail?: string;
};

/**
 * The coherent status a fused Train & launch exposes — ONE shape a timeline renders,
 * derived from the model's `buildState` and its in-flight train/deploy handles. Ordered
 * steps + an overall `phase` mirroring the underlying lifecycle so a caller can drive the
 * poll loop from a single field, and the real `error` (training or deploy) when a step fails.
 */
export type LaunchStatus = {
  /** The overall build phase (mirrors `ServiceModel.buildState`). */
  phase: ModelBuildState;
  /** Whether the whole fused launch reached `deployed` (the terminal success). */
  launched: boolean;
  /** The three ordered steps: reading data → training → publishing. */
  steps: LaunchStep[];
  /** The honest failure reason when a step failed (training or deploy), else undefined. */
  error?: string;
};

// --------------------------------------------------------------- Usage recording ---

/**
 * Per-model prediction USAGE — real, recorded on EVERY `predict` (allow AND deny). Cheap and
 * durable (persisted on the registry record via the same mirror the model uses); enough to draw
 * a score-distribution-over-time chart later without new infra. NOT fabricated: absent until the
 * model is actually called.
 *
 * Buckets are keyed by DAY (`YYYY-MM-DD`), then by BAND. For a classification model the bands are
 * score deciles `d0`..`d9` (d0 = [0,0.1), d9 = [0.9,1]); for a regression model they are coarse
 * value bands `b0`..`b9` over the observed range — the chart reads whichever `bandKind` says.
 */
export type UsageBucketKind = 'decile' | 'value-band';
export type ModelUsage = {
  /** Total predict calls seen (allow + deny). */
  count: number;
  /** How many of those were denied by governance (tier scope / tool grant). */
  denied: number;
  /** ISO timestamp of the most recent predict call. */
  lastCalledAt?: string;
  /** Which band scheme the histogram uses (decile for classification, value-band otherwise). */
  bandKind: UsageBucketKind;
  /** day (`YYYY-MM-DD`) → band key (`d0`..`d9` / `b0`..`b9`) → count of ALLOWED scored calls. */
  buckets: Record<string, Record<string, number>>;
};

/**
 * A deployed model exposed as a governed service. The `tier` is the security
 * boundary for who may call `predict` (via either front door); `consumptionMode`
 * is only meaningful once `tier==='Marketplace'`.
 */
export type ServiceModel = {
  id: string;
  /** Registry name (the KServe InferenceService + OPA tool identity), e.g. `churn_model`. */
  model: string;
  name: string;
  owner: string; // user id
  domain: string; // owning tenant
  tier: ModelTier;
  stage: ModelStage;
  /** The folder this model lives in (normalised path; `'/'` = root). Models are
   *  domain-scoped, so a model's folders live in the owning domain's tree. */
  folder?: string;
  /** Set when an Admin certifies into the Marketplace. */
  consumptionMode?: ConsumptionMode;
  /** Both front doors are auto-registered at the model's CURRENT tier (no publish step). */
  frontDoors: FrontDoor[];
  versions: ModelVersion[];
  /** Soft-archived (retained, reversible). Archived models drop out of the tab list
   *  until restored; delete is reachable only once archived (the OS-wide lifecycle). */
  archived?: boolean;
  // --- Phase-1 artifact-model additions (all optional → back-compatible) --------
  /** The build-time spec (what to learn from what). Absent on legacy seed rows. */
  spec?: ModelSpec;
  /** The MLOps build lifecycle state (draft → … → deployed). */
  buildState?: ModelBuildState;
  /** A short human description shown on the tile/detail. */
  description?: string;
  /** Headline eval metrics for the current version. */
  metrics?: ModelMetrics;
  /** The MLflow run this model's current version tracks (registry cross-link). */
  mlflowRunId?: string;
  /** The KServe InferenceService name backing `predict` (defaults to `model`). */
  kserveService?: string;
  /** The in-flight training Job name (set while `buildState==='training'`). */
  trainingJob?: string;
  /** The namespace that training Job runs in (for the poll path). */
  trainingNamespace?: string;
  /** The last training failure reason (set on failTraining; shown in the builder). */
  lastTrainingError?: string;
  /** The last deploy failure reason (set on failDeploy; shown in the builder). */
  lastDeployError?: string;
  /** Real per-model prediction usage — recorded on every predict (absent until first called). */
  usage?: ModelUsage;
  /** ISO timestamps (creation / last mutation). */
  createdAt?: string;
  updatedAt?: string;
};

/** The caller of a `predict` front door — a Software app/external (rest) or an agent (mcp). */
export type Caller = {
  /** OPA principal (LiteLLM key / Ory identity) — e.g. `sales-assistant`, `churn-risk-app`. */
  principal: string;
  /**
   * The caller's domain(s) — DERIVED FROM THE SESSION, never the request body.
   * Tier scope is satisfied when ANY of these is in the model's callable scope,
   * so a user in domain X can never claim domain Y to reach Y's model.
   */
  domains: string[];
  /** True when the caller is an agent (MCP front door); false for a Software app (REST). */
  isAgent: boolean;
};

/**
 * The compiled `predict` policy for one model — the policy-compiler mirror of the
 * OPA data bundle. Authored ONCE (the model's tier + consumption mode) and the
 * shape both front doors evaluate against, so REST and MCP can never drift.
 */
export type CompiledPredictPolicy = {
  model: string;
  tier: ModelTier;
  /** Principals that may always call (the owner's identity + the model's own principal). */
  allowedPrincipals: string[];
  /** Domains whose members may call (widens as the tier rises). */
  allowedDomains: string[];
  /** True at Marketplace tier — any domain may call, subject to its import grant. */
  crossDomain: boolean;
  consumptionMode?: ConsumptionMode;
};

/** Who is acting on a lifecycle transition (promote / go-live / certify). */
export type Actor = {
  id: string;
  role: 'user' | 'builder' | 'domain_admin' | 'admin';
  domains: string[];
  /** Hard invariant: an agent actor can NEVER certify, go-live, or self-promote. */
  isAgent: boolean;
};
