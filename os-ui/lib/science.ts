/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { config } from '@/lib/config';

/**
 * Science (Layer 4 / ML) golden-path support — the "Churn model" vertical slice.
 *
 * This module is the server-only spine for the Science tab: it probes the real
 * Layer-4 backends (Featureform, MLflow, KServe) and degrades gracefully to a
 * deterministic offline seed so the whole churn flow is demonstrable on a laptop
 * with `ml.enabled=false` and no cluster. Nothing here holds a secret; the
 * browser only ever receives the staged result + the (browser-reachable) console
 * links from `lib/config`.
 *
 * The slice mirrors science-golden-path.md §"Worked example — Churn model":
 *   1 Explore → 2 Features (Featureform) → 3 Train+track (MLflow) →
 *   4 Register/compare → 5 Certify+go-live (Builder) → 6 Deploy (KServe) →
 *   7 Consume (governed `predict` tool) → 8 Monitor & retrain (Dagster).
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

// --------------------------------------------------------- Churn-model facts ---

/** Canonical churn-model identity — the principal the Sales Assistant uses. */
export const CHURN = {
  model: 'churn_model',
  /** OPA principal granted the governed `predict` tool (values.yaml opa.grants). */
  principal: 'churn-model',
  domain: 'sales',
  dataProduct: 'sales.customer_360', // Iceberg mart seeded into the notebook (step 1)
  featureSet: 'customer_rfm', // Featureform `features` artifact (step 2)
  // The RFM+tenure features (offline on Iceberg, online in Valkey).
  features: ['recency_days', 'order_frequency', 'monetary_value', 'tenure_months'] as const,
} as const;

export type FeatureName = (typeof CHURN.features)[number];
export type ChurnFeatures = Record<FeatureName, number>;

/** A representative at-risk account the Sales Assistant flags (offline seed). */
export const ACME_FEATURES: ChurnFeatures = {
  recency_days: 95, // last order 95 days ago (lapsing)
  order_frequency: 2, // only 2 orders/year
  monetary_value: 4200,
  tenure_months: 14,
};

// --------------------------------------------------- The governed predict tool ---

export type PredictResult = {
  account: string;
  score: number; // P(churn) in [0,1]
  band: 'low' | 'medium' | 'high';
  features: ChurnFeatures;
  modelVersion: string;
  source: 'kserve' | 'seed-offline';
};

/**
 * Deterministic churn scorer used both for the offline fallback AND as the
 * teaching reference — a transparent logistic over the RFM+tenure features so
 * the score is explainable and never drifts between runs. (The real Production
 * model is the XGBoost classifier served by KServe; this mirrors its shape.)
 */
function seedScore(f: ChurnFeatures): number {
  // Higher recency (longer since last order) + lower frequency/tenure => churn.
  const z =
    -2.2 +
    0.025 * f.recency_days -
    0.45 * f.order_frequency -
    0.00008 * f.monetary_value -
    0.06 * f.tenure_months;
  const p = 1 / (1 + Math.exp(-z));
  return Math.min(0.999, Math.max(0.001, p));
}

function band(score: number): PredictResult['band'] {
  if (score >= 0.66) return 'high';
  if (score >= 0.33) return 'medium';
  return 'low';
}

/**
 * The `predict` tool body. Tries the KServe InferenceService (sklearn/xgboost
 * v2 protocol) and falls back to the deterministic seed when KServe is absent
 * (the default, `ml.enabled=false`). The caller is responsible for OPA
 * authorization + Langfuse tracing (see app/api/science/predict/route.ts) — this
 * function only computes the score.
 */
export async function predictTool(
  account: string,
  features: ChurnFeatures,
  modelVersion = 'v2',
): Promise<PredictResult> {
  // v2 inference protocol payload (KServe RawDeployment, sklearn/xgboost runtime).
  const payload = {
    inputs: [
      {
        name: 'input-0',
        shape: [1, CHURN.features.length],
        datatype: 'FP32',
        data: CHURN.features.map((k) => features[k]),
      },
    ],
  };
  const res = await withTimeout(
    `${config.kserveUrl}/v2/models/${CHURN.model}/infer`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload),
    },
    2500,
  );
  if (res && res.ok) {
    try {
      const data = (await res.json()) as { outputs?: { data?: number[] }[] };
      const raw = data?.outputs?.[0]?.data?.[0];
      if (typeof raw === 'number' && Number.isFinite(raw)) {
        const score = Math.min(0.999, Math.max(0.001, raw));
        return { account, score, band: band(score), features, modelVersion, source: 'kserve' };
      }
    } catch {
      /* fall through to seed */
    }
  }
  const score = seedScore(features);
  return { account, score, band: band(score), features, modelVersion, source: 'seed-offline' };
}

// ------------------------------------------------- Stage state for the UI flow ---

export type StageStatus = 'live' | 'ready' | 'pending';
export type Stage = {
  key: string;
  n: number;
  label: string;
  desc: string;
  backend: string;
  status: StageStatus;
  /** Who drives this stage (role hint for the teaching UI). */
  actor: 'Creator' | 'Builder' | 'User' | 'Platform';
};

export type FeatureRow = { name: string; entity: string; offline: string; online: string };
export type ModelVersion = {
  version: string;
  stage: 'Staging' | 'Production' | 'Archived';
  auc: number;
  certified: boolean;
  runId: string;
};

export type ChurnSlice = {
  model: string;
  dataProduct: string;
  featureSet: string;
  backends: { featureform: boolean; mlflow: boolean; kserve: boolean };
  stages: Stage[];
  featuresLive: boolean;
  registryLive: boolean;
  features: FeatureRow[];
  versions: ModelVersion[];
  // The reference at-risk account + its features (used by the predict demo).
  sample: { account: string; features: ChurnFeatures };
};

/** Offline-seed Featureform `features` artifact (the RFM feature set). */
const FEATURE_SEED: FeatureRow[] = [
  { name: 'recency_days', entity: 'customer', offline: 'iceberg:sales.customer_360', online: 'valkey' },
  { name: 'order_frequency', entity: 'customer', offline: 'iceberg:sales.customer_360', online: 'valkey' },
  { name: 'monetary_value', entity: 'customer', offline: 'iceberg:sales.customer_360', online: 'valkey' },
  { name: 'tenure_months', entity: 'customer', offline: 'iceberg:sales.customer_360', online: 'valkey' },
];

/** Offline-seed MLflow registry: v1 (archived) vs v2 (Production, certified). */
const VERSION_SEED: ModelVersion[] = [
  { version: 'v2', stage: 'Production', auc: 0.871, certified: true, runId: 'mlf-run-2a9c' },
  { version: 'v1', stage: 'Archived', auc: 0.842, certified: false, runId: 'mlf-run-17fe' },
];

export async function churnSlice(): Promise<ChurnSlice> {
  // Probe the three Layer-4 backends in parallel (graceful: absent => seed).
  const [ff, mlf, ks] = await Promise.all([
    reachable(`${config.featureformUrl}/`),
    reachable(`${config.mlflowUrl}/health`),
    reachable(`${config.kserveUrl}/`),
  ]);

  const stage = (status: StageStatus): StageStatus => status;
  const stages: Stage[] = [
    {
      key: 'explore',
      n: 1,
      label: 'Explore',
      desc: `JupyterHub notebook seeded from the governed ${CHURN.dataProduct} data product (no raw creds).`,
      backend: 'JupyterHub · Iceberg',
      actor: 'Creator',
      status: stage('ready'),
    },
    {
      key: 'features',
      n: 2,
      label: 'Build features',
      desc: 'RFM + tenure registered in Featureform — offline on Iceberg, online in Valkey.',
      backend: 'Featureform',
      actor: 'Creator',
      status: ff ? 'live' : 'ready',
    },
    {
      key: 'train',
      n: 3,
      label: 'Train & track',
      desc: 'XGBoost classifier; params/metrics/artifacts logged to MLflow (repeatable as a Dagster job).',
      backend: 'MLflow · Dagster',
      actor: 'Creator',
      status: mlf ? 'live' : 'ready',
    },
    {
      key: 'register',
      n: 4,
      label: 'Register & compare',
      desc: 'Best run registered as a model version; v1 vs v2 compared in the MLflow registry.',
      backend: 'MLflow registry',
      actor: 'Creator',
      status: mlf ? 'live' : 'ready',
    },
    {
      key: 'certify',
      n: 5,
      label: 'Certify & go-live',
      desc: 'Builder reviews AUC + lineage, certifies, and approves the Staging→Production transition.',
      backend: 'Role model · audit',
      actor: 'Builder',
      status: stage('ready'),
    },
    {
      key: 'deploy',
      n: 6,
      label: 'Deploy & serve',
      desc: 'KServe InferenceService from the registry artifact (CPU default; GPU opt-in + approved).',
      backend: 'KServe',
      actor: 'Builder',
      status: ks ? 'live' : 'pending',
    },
    {
      key: 'consume',
      n: 7,
      label: 'Consume',
      desc: 'Exposed as a governed `predict` MCP tool — OPA-gated, Langfuse-traced, online features from Valkey.',
      backend: 'OPA · LiteLLM · Langfuse',
      actor: 'User',
      status: stage('ready'),
    },
    {
      key: 'monitor',
      n: 8,
      label: 'Monitor & retrain',
      desc: 'Inference + drift watched; Dagster schedules a monthly retrain → new version → re-certify.',
      backend: 'Dagster',
      actor: 'Platform',
      status: stage('ready'),
    },
  ];

  return {
    model: CHURN.model,
    dataProduct: CHURN.dataProduct,
    featureSet: CHURN.featureSet,
    backends: { featureform: ff, mlflow: mlf, kserve: ks },
    stages,
    featuresLive: ff,
    registryLive: mlf,
    features: FEATURE_SEED,
    versions: VERSION_SEED,
    sample: { account: 'ACME', features: ACME_FEATURES },
  };
}
