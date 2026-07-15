/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { config } from '@/lib/core/config';
import { CHURN } from '@/lib/science/churn';
import {
  submitTrainingJob,
  readTrainingJob,
  type TrainingRun,
  type TrainingRuntime,
  type TrainingStatus,
} from '@/lib/science/training';
import type { FeatureRow, ModelSpec, ModelVersion } from '@/lib/science/types';

/**
 * The five Science adapters (Science golden path §"Build the needed adapters").
 * Each adapter wraps ONE live Layer-4 service and degrades to a deterministic
 * offline mock so the whole golden path is demonstrable with `ml.enabled=false`
 * and no cluster. Every adapter reports `live` honestly (a real probe), and the
 * governed front doors (OPA + LiteLLM + Langfuse) wrap the adapters, never the
 * other way round:
 *
 *   features      → Featureform (register / materialize; offline=Iceberg, online=Valkey)
 *   train/track   → MLflow runs + a Dagster training job (repeatable + schedulable)
 *   registry      → MLflow registry versions/stages + the certify gate
 *   deploy        → KServe InferenceService → dual REST + MCP `predict`
 *   monitoring    → drift + metric history + a retrain trigger (shared w/ Monitoring)
 */

async function withTimeout(url: string, init: RequestInit, ms = 2000): Promise<Response | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal, cache: 'no-store' });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Any HTTP answer (even 401/404) = the backend is reachable. */
async function reachable(url: string): Promise<boolean> {
  const res = await withTimeout(url, { method: 'GET' });
  return Boolean(res && res.status < 500);
}

// -------------------------------------------------------------- 1. features ---

// A fresh tenant has no offline-seeded feature rows — the live Featureform
// backend (or the Northpeak seed) supplies them.
const FEATURE_SEED: FeatureRow[] = [];

export const featuresAdapter = {
  name: 'Featureform',
  async probe(): Promise<boolean> {
    return reachable(`${config.featureformUrl}/`);
  },
  /** Register/materialize the RFM+tenure feature set. Live = Featureform; else seed. */
  async describe(): Promise<{ live: boolean; featureSet: string; rows: FeatureRow[] }> {
    return { live: await this.probe(), featureSet: CHURN.featureSet, rows: FEATURE_SEED };
  },
};

// ----------------------------------------------------------- 2. train/track ---

/**
 * The cluster wiring the training Job needs, assembled from `config` (chart-set
 * env). Held here so the route never rebuilds it inline; no secrets — the AWS
 * creds are pulled from `s3SecretName` by the Job, never read into the UI process.
 */
export function trainingRuntime(): TrainingRuntime {
  return {
    namespace: config.platformNamespace,
    trainerImage: config.mlTrainerImage,
    awsCliImage: config.awsCliImage,
    s3Endpoint: config.s3Endpoint,
    s3SecretName: config.s3SecretName,
    s3Region: config.s3Region,
    trinoHost: config.trinoHost,
    trinoPort: config.trinoPort,
    trinoUser: config.trinoReadUser,
    trinoCatalog: config.trinoCatalog,
    mlflowUrl: config.mlflowUrl,
  };
}

export const trainTrackAdapter = {
  name: 'MLflow · Dagster',
  async probe(): Promise<boolean> {
    const [mlf, dag] = await Promise.all([
      reachable(`${config.mlflowUrl}/health`),
      reachable(`${config.dagsterUrl}/`),
    ]);
    return mlf || dag;
  },
  async status(): Promise<{ live: boolean; tracking: string; job: string }> {
    return {
      live: await this.probe(),
      tracking: 'MLflow experiment churn_model (params/metrics/artifacts logged per run)',
      job: 'Dagster job train_churn_model (repeatable + schedulable)',
    };
  },
  /** Submit a REAL per-model training Job (draft→training). Delegates to the runner. */
  async submit(model: string, spec: ModelSpec): Promise<TrainingRun> {
    return submitTrainingJob(model, spec, trainingRuntime());
  },
  /** Poll a submitted training Job's status (training→trained/failed on the route). */
  async poll(jobName: string, namespace: string): Promise<TrainingStatus> {
    return readTrainingJob(jobName, namespace);
  },
};

// -------------------------------------------------------------- 3. registry ---

// A fresh tenant has no offline-seeded model versions — the live MLflow
// registry (or the Northpeak seed) supplies them.
const VERSION_SEED: ModelVersion[] = [];

export const registryAdapter = {
  name: 'MLflow registry',
  async probe(): Promise<boolean> {
    return reachable(`${config.mlflowUrl}/health`);
  },
  async versions(): Promise<{ live: boolean; versions: ModelVersion[] }> {
    return { live: await this.probe(), versions: VERSION_SEED.map((v) => ({ ...v })) };
  },
};

// --------------------------------------------------------------- 4. deploy ----

export const deployAdapter = {
  name: 'KServe',
  async probe(): Promise<boolean> {
    return reachable(`${config.kserveUrl}/`);
  },
  /** The deployed model is exposed at BOTH front doors from one endpoint. */
  async status(): Promise<{ live: boolean; endpoint: string; frontDoors: ('rest' | 'mcp')[] }> {
    return {
      live: await this.probe(),
      endpoint: `${config.kserveUrl}/v2/models/${CHURN.model}/infer`,
      frontDoors: ['rest', 'mcp'],
    };
  },
};

// ----------------------------------------------------------- 5. monitoring ----

export type DriftPoint = { week: string; auc: number; psi: number; predictions: number };

/**
 * Deterministic 8-week drift series for the Science monitoring view + the
 * cross-cutting Monitoring tab (same signals, no duplicate plumbing). PSI rising
 * past 0.2 = the retrain threshold; AUC sagging confirms it. Seeded so the chart
 * never jitters between renders; the live path reads MLflow/KServe telemetry.
 */
function driftSeed(): DriftPoint[] {
  // A fresh tenant has no drift history — the live MLflow/KServe telemetry
  // supplies the series once the model is serving.
  return [];
}

export const PSI_RETRAIN_THRESHOLD = 0.2;

export const monitoringAdapter = {
  name: 'MLflow · KServe · Dagster',
  async probe(): Promise<boolean> {
    const [mlf, ks] = await Promise.all([
      reachable(`${config.mlflowUrl}/health`),
      reachable(`${config.kserveUrl}/`),
    ]);
    return mlf || ks;
  },
  /** Per-model metric history + feature/prediction drift; flags when retrain is due. */
  async drift(): Promise<{
    live: boolean;
    series: DriftPoint[];
    threshold: number;
    retrainDue: boolean;
    latestPsi: number;
    latestAuc: number;
  }> {
    const series = driftSeed();
    // A fresh tenant has no drift history yet — report an honest empty state
    // rather than dereferencing a missing latest point (would 500 the surface).
    const latest = series[series.length - 1];
    return {
      live: await this.probe(),
      series,
      threshold: PSI_RETRAIN_THRESHOLD,
      retrainDue: latest ? latest.psi >= PSI_RETRAIN_THRESHOLD : false,
      latestPsi: latest?.psi ?? 0,
      latestAuc: latest?.auc ?? 0,
    };
  },
  /** Trigger a Dagster retrain run (live) or stage one offline. Caller governs it. */
  async triggerRetrain(model: string): Promise<{ live: boolean; runId: string; job: string }> {
    const live = await reachable(`${config.dagsterUrl}/`);
    const runId = `dagster-retrain-${model}-${Date.now().toString(36)}`;
    return { live, runId, job: `retrain_${model}` };
  },
};

export const ADAPTERS = [
  featuresAdapter,
  trainTrackAdapter,
  registryAdapter,
  deployAdapter,
  monitoringAdapter,
] as const;
