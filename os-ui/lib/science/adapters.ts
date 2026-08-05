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
import {
  submitDeploy,
  readDeploy,
  type DeployRuntime,
  type DeployStatus,
} from '@/lib/science/deploy';
import type { ModelSpec, ModelVersion } from '@/lib/science/types';

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

/**
 * Featureform is NOT wired into the Science golden path — the training runner reads the
 * governed Gold product directly through Trino (see `training.ts`), it does not go through a
 * feature store. This adapter was probe/seed plumbing for a DevConsole tile Phase B deletes;
 * gutted to an HONEST 'not wired' stub (no fabricated feature rows, no misleading liveness) so
 * the (soon-to-be-removed) tile renders truthfully until then. `probe()` always returns false —
 * there is no Featureform to be live.
 */
export const featuresAdapter = {
  name: 'Featureform',
  async probe(): Promise<boolean> {
    return false; // not wired into Science — training reads Gold through Trino, not a feature store
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

/**
 * The cluster wiring a per-model deploy needs. The KServe predictor
 * ServiceAccount comes from env (chart `kserve.serviceAccountName`, wired as
 * KSERVE_SERVICE_ACCOUNT on the os-ui pod) with the chart's default as fallback.
 */
export function deployRuntime(): DeployRuntime {
  return {
    namespace: config.platformNamespace,
    serviceAccountName: process.env.KSERVE_SERVICE_ACCOUNT || 'kserve-sa',
  };
}

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
  /** Create/reconcile the model's InferenceService (trained artifact → live endpoint). */
  async submit(model: string): Promise<{ isvc: string; storageUri: string }> {
    return submitDeploy(model, deployRuntime());
  },
  /** Poll the InferenceService's Ready state (deploying → deployed/deploy_failed). */
  async poll(model: string): Promise<DeployStatus> {
    return readDeploy(model, deployRuntime());
  },
};

// ----------------------------------------------------------- 5. monitoring ----

/**
 * Monitoring liveness ONLY. Drift telemetry and the retrain trigger are NOT wired to a real
 * monitor — the previous `drift()` returned a fabricated-shaped empty series and `triggerRetrain()`
 * invented a `dagster-retrain-<ts>` runId WITHOUT ever calling Dagster (an honesty violation). Both
 * are removed. `probe()` remains a real liveness check for the adapter status grid; real input/label
 * drift + a governed retrain trigger are Phase-B work (a serving-side feature/label monitor).
 */
export const monitoringAdapter = {
  name: 'MLflow · KServe · Dagster',
  async probe(): Promise<boolean> {
    const [mlf, ks] = await Promise.all([
      reachable(`${config.mlflowUrl}/health`),
      reachable(`${config.kserveUrl}/`),
    ]);
    return mlf || ks;
  },
};

export const ADAPTERS = [
  featuresAdapter,
  trainTrackAdapter,
  registryAdapter,
  deployAdapter,
  monitoringAdapter,
] as const;
