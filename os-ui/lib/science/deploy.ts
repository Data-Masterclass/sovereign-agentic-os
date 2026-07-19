/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
// PURE, dependency-injected DEPLOY runner (no `server-only`, no top-level VALUE
// `@/` imports) so it is unit-tested with `node --test` — the exact discipline of
// its sibling `training.ts`. The single live dependency (the in-cluster k8s API)
// is INJECTED via `K8sClient`; the default binding is dynamically imported.
import type { K8sClient } from './training.ts';
import { modelStorageUri } from './training.ts';

/**
 * The Science DEPLOY step — the runtime half of the per-model serving story. The
 * chart's `kserve-served-models.yaml` renders the DECLARATIVE half (an operator
 * lists trained models in values); this module creates/reconciles the SAME
 * InferenceService shape at runtime when the owner clicks Deploy on a TRAINED
 * model:
 *
 *   • name           = DNS-safe form of the model id (`lead_scoring` → `lead-scoring`)
 *   • storageUri     = s3://mlflow/models/<model> (exactly where training uploaded)
 *   • RawDeployment  + v2 protocol + the mlserver_sklearn runtime (modelClass label)
 *   • CPU-only resources, the chart's kserve ServiceAccount (S3 read creds)
 *
 * Idempotent GET → PUT-with-resourceVersion / POST (the `lib/software/runner.ts`
 * pattern) and HONEST degradation: an unreachable API server is a typed 503 —
 * never a fake "deployed".
 */

/** The cluster wiring a deploy needs — injected from config/env (no secrets). */
export type DeployRuntime = {
  namespace: string;
  /** The KServe predictor ServiceAccount (chart `kserve.serviceAccountName`) — carries the S3 read creds. */
  serviceAccountName: string;
};

export type DeployPhase = 'ready' | 'progressing' | 'failed' | 'unknown';

export type DeployStatus = {
  isvc: string;
  phase: DeployPhase;
  /** A short human reason (Ready condition / model-load state) for the UI. */
  reason: string;
};

const ISVC_API = '/apis/serving.kserve.io/v1beta1';

/** DNS-1123-safe InferenceService name for a model id (underscores → hyphens). */
export function isvcName(model: string): string {
  return model
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '');
}

/** The in-cluster base URL of a deployed model's predictor Service (RawDeployment). */
export function isvcServiceUrl(model: string): string {
  return `http://${isvcName(model)}-predictor:80`;
}

/**
 * Build the InferenceService manifest for a trained model — the PURE core,
 * mirroring the chart's `kserve-served-models.yaml` exactly (RawDeployment, v2
 * protocol, mlserver_sklearn via the `modelClass` label, CPU-only resources).
 */
export function buildInferenceService(model: string, rt: DeployRuntime): Record<string, unknown> {
  return {
    apiVersion: 'serving.kserve.io/v1beta1',
    kind: 'InferenceService',
    metadata: {
      name: isvcName(model),
      namespace: rt.namespace,
      labels: {
        'app.kubernetes.io/managed-by': 'os-ui',
        'sovereign-os/component': 'model-serving',
        'sovereign-os/model': model,
        // The kserve-mlserver ClusterServingRuntime templates
        // MLSERVER_MODEL_IMPLEMENTATION from this label.
        modelClass: 'mlserver_sklearn.SKLearnModel',
      },
      annotations: { 'serving.kserve.io/deploymentMode': 'RawDeployment' },
    },
    spec: {
      predictor: {
        serviceAccountName: rt.serviceAccountName,
        model: {
          modelFormat: { name: 'sklearn' },
          protocolVersion: 'v2',
          // The training runtime uploaded model.joblib + model-settings.json here.
          storageUri: modelStorageUri(model),
          resources: {
            requests: { cpu: '100m', memory: '256Mi' },
            limits: { cpu: '1', memory: '1Gi' },
          },
        },
      },
    },
  };
}

/** Default binding: the in-cluster k8s client (dynamic so `node --test` skips it). */
async function defaultK8s(): Promise<K8sClient> {
  const { k8s } = await import('@/lib/infra/k8s');
  return k8s;
}

/**
 * Create or reconcile the model's InferenceService (idempotent: GET → PUT with the
 * live resourceVersion, or POST when absent). Returns the isvc name + storageUri;
 * throws a status-tagged error when the cluster is unreachable (503) or rejects
 * the manifest (502/409) — so the route surfaces it honestly.
 */
export async function submitDeploy(
  model: string,
  rt: DeployRuntime,
  client?: K8sClient,
): Promise<{ isvc: string; storageUri: string }> {
  const k = client ?? (await defaultK8s());
  const name = isvcName(model);
  const collection = `${ISVC_API}/namespaces/${rt.namespace}/inferenceservices`;
  const manifest = buildInferenceService(model, rt);

  const existing = await k('GET', `${collection}/${name}`);
  if (existing.status === 0) {
    const e = new Error('The serving cluster is unreachable (no in-cluster Kubernetes API) — is Science deployed?');
    (e as Error & { status?: number }).status = 503;
    throw e;
  }
  let res;
  if (existing.status === 200) {
    const meta = (existing.body.metadata ?? {}) as Record<string, unknown>;
    (manifest.metadata as Record<string, unknown>).resourceVersion = meta.resourceVersion;
    res = await k('PUT', `${collection}/${name}`, manifest);
  } else if (existing.status === 404) {
    res = await k('POST', collection, manifest);
  } else {
    res = existing;
  }
  if (res.status === 0) {
    const e = new Error('The serving cluster became unreachable while applying the InferenceService');
    (e as Error & { status?: number }).status = 503;
    throw e;
  }
  if (res.status >= 300) {
    const msg = (res.body?.message as string) || `Kubernetes rejected the InferenceService (${res.status})`;
    const e = new Error(msg);
    (e as Error & { status?: number }).status = res.status === 409 ? 409 : 502;
    throw e;
  }
  return { isvc: name, storageUri: modelStorageUri(model) };
}

/** Map an InferenceService `.status` block onto our coarse deploy phase. */
export function deployPhase(status: Record<string, unknown> | undefined): { phase: DeployPhase; reason: string } {
  if (!status) return { phase: 'progressing', reason: 'no status yet' };
  const conditions = (status.conditions as { type?: string; status?: string; reason?: string; message?: string }[] | undefined) ?? [];
  const ready = conditions.find((c) => c.type === 'Ready');
  if (ready?.status === 'True') return { phase: 'ready', reason: 'InferenceService is Ready' };
  // A blocked/failed model load is a terminal failure, not "still progressing".
  const modelStatus = (status.modelStatus ?? {}) as { transitionStatus?: string; lastFailureInfo?: { message?: string } };
  if (modelStatus.transitionStatus === 'BlockedByFailedLoad' || modelStatus.transitionStatus === 'InvalidSpec') {
    return {
      phase: 'failed',
      reason: modelStatus.lastFailureInfo?.message ?? `model load failed (${modelStatus.transitionStatus})`,
    };
  }
  const detail = ready?.message ?? ready?.reason ?? 'rolling out the predictor';
  return { phase: 'progressing', reason: detail };
}

/** Read a deploy's live status (poll). Never throws — an unreachable API is `unknown`. */
export async function readDeploy(
  model: string,
  rt: DeployRuntime,
  client?: K8sClient,
): Promise<DeployStatus> {
  const k = client ?? (await defaultK8s());
  const name = isvcName(model);
  const res = await k('GET', `${ISVC_API}/namespaces/${rt.namespace}/inferenceservices/${name}`);
  if (res.status === 0) return { isvc: name, phase: 'unknown', reason: 'cluster unreachable' };
  if (res.status === 404) return { isvc: name, phase: 'failed', reason: 'InferenceService not found — re-run Deploy' };
  if (res.status >= 400) return { isvc: name, phase: 'unknown', reason: `Kubernetes API error (${res.status})` };
  const { phase, reason } = deployPhase(res.body?.status as Record<string, unknown> | undefined);
  return { isvc: name, phase, reason };
}
