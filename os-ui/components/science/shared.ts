/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * Client-side contract types + tiny helpers for the Science tab. These MIRROR the
 * shapes the science routes return (lib/science/*) — the UI never imports the
 * server modules, it only consumes the JSON. Kept deliberately small: Phase 1
 * lists models, opens one, predicts, promotes and runs the lifecycle; the guided
 * train/deploy + inline eval/monitor charts are Phase 2-4.
 */

export type ModelTier = 'Personal' | 'Domain' | 'Marketplace';
export type ModelStage = 'Staging' | 'Production' | 'Archived';
export type TaskType =
  | 'binary_classification'
  | 'multiclass_classification'
  | 'regression'
  | 'forecast'
  | 'clustering';
export type ModelBuildState =
  | 'draft'
  | 'training'
  | 'trained'
  | 'deploying'
  | 'deploy_failed'
  | 'deployed'
  | 'monitored'
  | 'archived';

export type ModelSpec = {
  sourceDataProductFqn: string;
  sourceDatasetId?: string;
  targetColumn: string | null;
  taskType: TaskType;
  algorithm: string;
  features: string[];
  trainTestSplit: number;
  optimizeMetric: string;
};

export type ModelMetrics = {
  primary?: number;
  primaryMetric?: string;
  secondary?: Record<string, number>;
};

export type ModelVersion = {
  version: string;
  stage: ModelStage;
  auc: number;
  certified: boolean;
  runId: string;
};

export type CompiledPredictPolicy = {
  model: string;
  tier: ModelTier;
  allowedPrincipals: string[];
  allowedDomains: string[];
  crossDomain: boolean;
  consumptionMode?: 'read-in-place' | 'fork-allowed';
};

/** One model as the tab consumes it — the ServiceModel shape + its compiled policy. */
export type ModelSummary = {
  id: string;
  model: string;
  name: string;
  owner: string;
  domain: string;
  tier: ModelTier;
  stage: ModelStage;
  frontDoors: ('rest' | 'mcp')[];
  versions: ModelVersion[];
  archived?: boolean;
  spec?: ModelSpec;
  buildState?: ModelBuildState;
  description?: string;
  metrics?: ModelMetrics;
  mlflowRunId?: string;
  kserveService?: string;
  lastTrainingError?: string;
  lastDeployError?: string;
  createdAt?: string;
  updatedAt?: string;
  consumptionMode?: 'read-in-place' | 'fork-allowed';
  policy: CompiledPredictPolicy;
};

/** The grouped payload GET /api/science/model returns (plus the flat back-compat list). */
export type ModelGroups = {
  mlEnabled: boolean;
  gpuEnabled?: boolean;
  models: ModelSummary[];
  mine: ModelSummary[];
  domain: ModelSummary[];
  marketplace: ModelSummary[];
};

export type PredictResult = {
  decision: 'allow' | 'deny' | 'requires_approval';
  frontDoor: 'rest' | 'mcp';
  tier: ModelTier;
  policy: string;
  principal?: string;
  requestedBy?: string;
  account?: string;
  score?: number;
  band?: 'low' | 'medium' | 'high';
  source?: string;
  modelVersion?: string;
  reason?: string;
  traceId?: string;
};

// --- display maps (badges/labels mirror the OS-wide vocabulary) ------------------

export const TIER_LABEL: Record<ModelTier, string> = {
  Personal: 'Personal',
  Domain: 'Domain',
  Marketplace: 'Company',
};
export const TIER_BADGE: Record<ModelTier, string> = {
  Personal: 'vis-personal',
  Domain: 'vis-shared',
  Marketplace: 'vis-certified',
};

export const TASK_LABEL: Record<TaskType, string> = {
  binary_classification: 'Binary classification',
  multiclass_classification: 'Multiclass',
  regression: 'Regression',
  forecast: 'Forecast',
  clustering: 'Clustering',
};

/** buildState → { label, dot } — the coloured status dot on tiles + detail. */
export const BUILD_STATE: Record<ModelBuildState, { label: string; dot: string }> = {
  draft: { label: 'Draft', dot: 'muted' },
  training: { label: 'Training', dot: 'warn' },
  trained: { label: 'Trained', dot: 'ok' },
  deploying: { label: 'Deploying', dot: 'warn' },
  deploy_failed: { label: 'Deploy failed', dot: 'down' },
  deployed: { label: 'Deployed', dot: 'up' },
  monitored: { label: 'Monitored', dot: 'up' },
  archived: { label: 'Archived', dot: 'muted' },
};

export const TASK_TYPES: TaskType[] = [
  'binary_classification',
  'multiclass_classification',
  'regression',
  'forecast',
  'clustering',
];

/**
 * The task types this first CPU-sklearn runtime can ACTUALLY train — mirrors the
 * server's `SUPPORTED` set in lib/science/training.ts (classification + regression).
 * Kept here as a client-safe contract mirror so the Define stage only OFFERS trainable
 * tasks and honestly marks the rest "not yet trainable" (the audit found forecast /
 * clustering were offered but rejected at train time). If the runtime grows a learner,
 * update both this list and the server's SUPPORTED map together.
 */
export const TRAINABLE_TASKS: readonly TaskType[] = [
  'binary_classification',
  'multiclass_classification',
  'regression',
];

/** True when this runtime can train the task now (false for forecast / clustering). */
export const isTrainableTask = (t: TaskType): boolean => TRAINABLE_TASKS.includes(t);

/** POST JSON and surface the route's `error` field as a thrown Error. */
export async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}
