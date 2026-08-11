/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
// PURE, dependency-injected training-job runner (no `server-only`, no top-level
// VALUE `@/` imports) so it is unit-tested with `node --test`. The single live
// dependency (the in-cluster k8s API) is INJECTED via `K8sClient`; the default
// binding is dynamically imported by `submitTrainingJob`/`readTrainingJob` so the
// node test never touches the alias chain. Type-only `@/` imports are stripped.
import type { ModelSpec, TaskType } from '@/lib/science/types';

/**
 * The Science TRAINING RUNTIME — the parameterized generalization of the proven
 * `kserve-model-seed` Job (charts/.../science/kserve-model-seed.yaml). That hook
 * trains ONE hard-coded churn model; this submits a PER-MODEL batch/v1 Job driven
 * by the model's `ModelSpec`:
 *
 *   1. an init container (`sovereign-os/ml-trainer`) reads the governed Gold data
 *      product THROUGH Trino (a read-only BI/science principal — never raw creds,
 *      never a widened grant), trains a small CPU-only sklearn model for the spec's
 *      taskType/algorithm, logs the run to MLflow, and writes
 *      `model.joblib` + `model-settings.json` to an emptyDir;
 *   2. an upload container (the pinned aws-cli) publishes that artifact to
 *      `s3://mlflow/models/<model>/` — the exact path a per-model KServe
 *      InferenceService serves from.
 *
 * The k8s wiring (image, Trino host, MLflow URL, S3 endpoint, aws-cli image) is
 * INJECTED as `TrainingRuntime` — the route fills it from `config` + the chart's
 * values, so this module holds no secrets and stays test-safe.
 */

/** Minimal k8s client surface — matches `lib/infra/k8s.ts` `k8s(method, path, body)`. */
export type K8sClient = (
  method: string,
  path: string,
  body?: unknown,
) => Promise<{ status: number; body: Record<string, unknown> }>;

/** Plain-text k8s reader — matches `lib/infra/k8s.ts` `k8sText(path)` (pod logs). */
export type K8sTextClient = (path: string) => Promise<{ status: number; text: string }>;

/** The cluster wiring the Job needs — injected from `config` (no secrets inline). */
export type TrainingRuntime = {
  namespace: string;
  /** The `sovereign-os/ml-trainer` image (repo:tag) that runs the training script. */
  trainerImage: string;
  /** The pinned aws-cli image (mirrors objectStorage.awsCli) for the upload step. */
  awsCliImage: string;
  /** S3 endpoint the upload container targets (soa.s3Endpoint), e.g. http://minio:9000. */
  s3Endpoint: string;
  /** The Secret name holding AWS creds (objectStorage.secretName). */
  s3SecretName: string;
  /** AWS region (clients just need a value). */
  s3Region: string;
  /** Trino coordinator host:port + read principal the trainer queries Gold through. */
  trinoHost: string;
  trinoPort: number;
  /** The LEAST-PRIVILEGE read principal (BI/science) — never the owner's write identity. */
  trinoUser: string;
  trinoCatalog: string;
  /** MLflow tracking URI the run logs params/metrics/artifacts to. */
  mlflowUrl: string;
};

/** A run handle the route returns + polls on. */
export type TrainingRun = {
  model: string;
  jobName: string;
  namespace: string;
  /** Where the trained artifact is uploaded (the KServe storageUri). */
  storageUri: string;
};

export type TrainingPhase = 'pending' | 'running' | 'succeeded' | 'failed' | 'unknown';

export type TrainingStatus = {
  jobName: string;
  phase: TrainingPhase;
  /** True while the cluster is reachable and the job exists. */
  active: boolean;
  /** A short human reason (last condition message / pod waiting reason) for the UI. */
  reason: string;
  /** The Job's creationTimestamp (ISO) — lets the route enforce a pending deadline. */
  createdAt?: string;
};

// --------------------------------------------------------- honest algorithm set ---

/**
 * The SMALL, honest algorithm set this first runtime supports — CPU-only sklearn.
 * This is NOT an AutoML platform: classification → logistic/random-forest,
 * regression → linear/random-forest. An unknown/`auto` algorithm falls back to the
 * task's default; an unsupported taskType is rejected up front (no silent wrong run).
 */
const SUPPORTED: Record<string, { algorithms: string[]; defaultAlgorithm: string }> = {
  binary_classification: { algorithms: ['logistic', 'random_forest'], defaultAlgorithm: 'logistic' },
  multiclass_classification: { algorithms: ['logistic', 'random_forest'], defaultAlgorithm: 'logistic' },
  regression: { algorithms: ['linear', 'random_forest'], defaultAlgorithm: 'linear' },
};

/** True when this runtime can train the given task (forecast/clustering are not built yet). */
export function isTrainableTask(task: TaskType): boolean {
  return task in SUPPORTED;
}

/** Normalize the spec's free-text algorithm onto the supported set for the task. */
export function resolveAlgorithm(spec: ModelSpec): string {
  const s = SUPPORTED[spec.taskType];
  if (!s) return spec.algorithm;
  const a = (spec.algorithm || '').toLowerCase().replace(/[^a-z_]/g, '_');
  if (s.algorithms.includes(a)) return a;
  // Common aliases → the honest sklearn learner.
  if (a === 'xgboost' || a === 'gbm' || a === 'gradient_boosting' || a === 'rf') {
    return a === 'rf' ? 'random_forest' : s.defaultAlgorithm;
  }
  return s.defaultAlgorithm;
}

// --------------------------------------------------------------- the job spec ----

/** A DNS-1123 job name unique per submit (so a re-train never collides). */
export function trainingJobName(model: string, now = Date.now()): string {
  const slug = model.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40);
  return `train-${slug}-${now.toString(36)}`;
}

/** The S3 path the trained artifact is uploaded to = the KServe storageUri. */
export function modelStorageUri(model: string): string {
  return `s3://mlflow/models/${model}`;
}

/**
 * Build the batch/v1 Job manifest for a model's training run — the PURE core (no
 * cluster, no secrets). The trainer container gets ONLY spec facts + the injected
 * runtime as plain env; the AWS creds are pulled from the named Secret by the
 * upload container via `secretKeyRef`, never inlined. Mirrors the seed hook's
 * init(train)+container(upload)+emptyDir shape.
 */
export function buildTrainingJob(
  model: string,
  spec: ModelSpec,
  rt: TrainingRuntime,
  jobName: string,
): Record<string, unknown> {
  const storageUri = modelStorageUri(model);
  const algorithm = resolveAlgorithm(spec);
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: jobName,
      namespace: rt.namespace,
      labels: {
        'app.kubernetes.io/managed-by': 'os-ui',
        'sovereign-os/component': 'model-trainer',
        'sovereign-os/model': model,
      },
    },
    spec: {
      backoffLimit: 1,
      ttlSecondsAfterFinished: 3600,
      template: {
        metadata: { labels: { 'sovereign-os/component': 'model-trainer', 'sovereign-os/model': model } },
        spec: {
          restartPolicy: 'Never',
          securityContext: { runAsNonRoot: true, runAsUser: 1000 },
          initContainers: [
            {
              name: 'train',
              image: rt.trainerImage,
              command: ['python', '/app/train.py'],
              env: [
                // The Job name — train.py uses it as the MLflow run_name so the
                // route's poll can find the run (HOSTNAME is the POD name, which
                // carries a random suffix and never matches the Job-name lookup).
                { name: 'JOB_NAME', value: jobName },
                { name: 'MODEL_NAME', value: model },
                { name: 'TASK_TYPE', value: spec.taskType },
                { name: 'ALGORITHM', value: algorithm },
                { name: 'SOURCE_FQN', value: spec.sourceDataProductFqn },
                { name: 'TARGET_COLUMN', value: spec.targetColumn ?? '' },
                { name: 'FEATURES', value: spec.features.join(',') },
                { name: 'TRAIN_TEST_SPLIT', value: String(spec.trainTestSplit) },
                { name: 'OPTIMIZE_METRIC', value: spec.optimizeMetric },
                // Governed READ path — Trino as a least-privilege BI/science principal.
                { name: 'TRINO_HOST', value: rt.trinoHost },
                { name: 'TRINO_PORT', value: String(rt.trinoPort) },
                { name: 'TRINO_USER', value: rt.trinoUser },
                { name: 'TRINO_CATALOG', value: rt.trinoCatalog },
                { name: 'MLFLOW_TRACKING_URI', value: rt.mlflowUrl },
                { name: 'ARTIFACT_DIR', value: '/artifact' },
              ],
              volumeMounts: [{ name: 'artifact', mountPath: '/artifact' }],
              resources: { requests: { cpu: '250m', memory: '512Mi' }, limits: { cpu: '1', memory: '1Gi' } },
            },
          ],
          containers: [
            {
              name: 'upload',
              image: rt.awsCliImage,
              env: [
                { name: 'AWS_ACCESS_KEY_ID', valueFrom: { secretKeyRef: { name: rt.s3SecretName, key: 'AWS_ACCESS_KEY_ID' } } },
                { name: 'AWS_SECRET_ACCESS_KEY', valueFrom: { secretKeyRef: { name: rt.s3SecretName, key: 'AWS_SECRET_ACCESS_KEY' } } },
                { name: 'AWS_DEFAULT_REGION', value: rt.s3Region },
                { name: 'ENDPOINT', value: rt.s3Endpoint },
                { name: 'STORAGE_URI', value: storageUri },
              ],
              command: ['/bin/sh', '-c'],
              args: [
                [
                  'set -e',
                  'REST="${STORAGE_URI#s3://}"; BUCKET="${REST%%/*}"',
                  'aws --endpoint-url "$ENDPOINT" s3 ls "s3://$BUCKET" >/dev/null 2>&1 || aws --endpoint-url "$ENDPOINT" s3 mb "s3://$BUCKET" || echo "mb skipped"',
                  'aws --endpoint-url "$ENDPOINT" s3 cp --recursive /artifact "${STORAGE_URI%/}/"',
                  'echo "model trainer upload complete"',
                ].join('\n'),
              ],
              volumeMounts: [{ name: 'artifact', mountPath: '/artifact' }],
              resources: { requests: { cpu: '25m', memory: '64Mi' }, limits: { cpu: '200m', memory: '256Mi' } },
            },
          ],
          volumes: [{ name: 'artifact', emptyDir: {} }],
        },
      },
    },
  };
}

// ------------------------------------------------------ submit + poll (injected) ---

/** Default binding: the in-cluster k8s client (dynamic so `node --test` skips it). */
async function defaultK8s(): Promise<K8sClient> {
  const { k8s } = await import('@/lib/infra/k8s');
  return k8s;
}

/**
 * Submit a model's training Job to the cluster. Pure spec build + one POST to the
 * batch/v1 Jobs API via the injected client. Returns a run handle; throws a
 * status-tagged error if the API rejects it (so the route surfaces it honestly).
 */
export async function submitTrainingJob(
  model: string,
  spec: ModelSpec,
  rt: TrainingRuntime,
  client?: K8sClient,
): Promise<TrainingRun> {
  if (!isTrainableTask(spec.taskType)) {
    const e = new Error(`This runtime cannot train a ${spec.taskType} model yet (CPU sklearn: classification + regression only)`);
    (e as Error & { status?: number }).status = 400;
    throw e;
  }
  const k = client ?? (await defaultK8s());
  const jobName = trainingJobName(model);
  const manifest = buildTrainingJob(model, spec, rt, jobName);
  const res = await k('POST', `/apis/batch/v1/namespaces/${rt.namespace}/jobs`, manifest);
  if (res.status === 0) {
    const e = new Error('The training cluster is unreachable (no in-cluster Kubernetes API) — is Science deployed?');
    (e as Error & { status?: number }).status = 503;
    throw e;
  }
  if (res.status >= 300) {
    const msg = (res.body?.message as string) || `Kubernetes rejected the training Job (${res.status})`;
    const e = new Error(msg);
    (e as Error & { status?: number }).status = res.status === 409 ? 409 : 502;
    throw e;
  }
  return { model, jobName, namespace: rt.namespace, storageUri: modelStorageUri(model) };
}

/** Map a k8s Job `.status` block onto our coarse phase (the state machine's read side). */
export function jobPhase(status: Record<string, unknown> | undefined): TrainingStatus['phase'] {
  if (!status) return 'unknown';
  if (typeof status.succeeded === 'number' && status.succeeded > 0) return 'succeeded';
  if (typeof status.failed === 'number' && status.failed > 0) return 'failed';
  if (typeof status.active === 'number' && status.active > 0) return 'running';
  return 'pending';
}

/**
 * Surface WHY a pending Job's pod is not running (ImagePullBackOff, unschedulable,
 * …) from the pod's own container statuses — no Events RBAC needed. Best-effort:
 * any API hiccup returns ''.
 */
export async function podPendingReason(
  jobName: string,
  namespace: string,
  client: K8sClient,
): Promise<string> {
  const res = await client('GET', `/api/v1/namespaces/${namespace}/pods?labelSelector=job-name%3D${jobName}`);
  if (res.status !== 200) return '';
  const pods = (res.body?.items as Record<string, unknown>[] | undefined) ?? [];
  for (const pod of pods) {
    const st = (pod.status ?? {}) as Record<string, unknown>;
    const statuses = [
      ...((st.initContainerStatuses as { state?: { waiting?: { reason?: string; message?: string } } }[] | undefined) ?? []),
      ...((st.containerStatuses as { state?: { waiting?: { reason?: string; message?: string } } }[] | undefined) ?? []),
    ];
    for (const c of statuses) {
      const w = c.state?.waiting;
      if (w?.reason && w.reason !== 'PodInitializing' && w.reason !== 'ContainerCreating') {
        return w.message ? `${w.reason}: ${w.message}` : w.reason;
      }
    }
    const conds = (st.conditions as { type?: string; status?: string; message?: string }[] | undefined) ?? [];
    const unsched = conds.find((c) => c.type === 'PodScheduled' && c.status === 'False');
    if (unsched?.message) return unsched.message;
  }
  return '';
}

/**
 * The last N lines of a training run's REAL logs — the `train` init container's stdout/stderr
 * (where the sklearn traceback / Trino read error lands). Best-effort + honest: we resolve the
 * Job's pod (label `job-name=<job>`), then read that container's `/log` tail; ANY miss (no pod,
 * log not yet available, unreachable API, or a pod that never scheduled) returns '' so the caller
 * grounds in "no logs captured" instead of a fabricated trace. The default `logs` binding is the
 * plain-text in-cluster reader; `pods` is the JSON reader — both injected for `node --test`.
 */
export async function trainingLogs(
  jobName: string,
  namespace: string,
  tailLines: number,
  pods: K8sClient,
  logs: K8sTextClient,
): Promise<string> {
  const list = await pods('GET', `/api/v1/namespaces/${namespace}/pods?labelSelector=job-name%3D${jobName}`);
  if (list.status !== 200) return '';
  const items = (list.body?.items as Record<string, unknown>[] | undefined) ?? [];
  // Prefer the most recent pod (a re-run may leave an older one behind).
  const pod = items[items.length - 1];
  const name = ((pod?.metadata as { name?: string } | undefined)?.name) ?? '';
  if (!name) return '';
  const tail = Math.max(1, Math.min(200, Math.floor(tailLines)));
  const res = await logs(
    `/api/v1/namespaces/${namespace}/pods/${name}/log?container=train&tailLines=${tail}`,
  );
  if (res.status !== 200 || !res.text.trim()) return '';
  // Keep only the last `tail` lines (the API honors tailLines, but guard against a chatty stream).
  return res.text.trim().split('\n').slice(-tail).join('\n');
}

/**
 * Extract the first REAL error line from a training-log tail — the trainer's own message
 * (`fail(...)` prints `trainer: FATAL <msg>`) or the last line of a Python traceback — so the
 * route can record the ACTUAL cause instead of the generic k8s Job reason ("BackoffLimitExceeded"
 * / "Back-off restarting failed container"). Pure + honest: returns '' when the log has no
 * recognizable error signal (the caller then keeps the k8s reason). Prefers the trainer's own
 * `FATAL`/`ERROR:` marker, else the final Python exception line.
 */
export function firstTrainerError(log: string): string {
  const lines = log.split('\n').map((l) => l.trim()).filter(Boolean);
  // The trainer's own honest failure marker takes priority (`trainer: FATAL <msg>`).
  for (const l of lines) {
    const m = l.match(/trainer:\s*(?:FATAL|ERROR:?)\s*(.+)$/i);
    if (m) return m[1].trim();
  }
  // Otherwise the final Python exception line (e.g. "ValueError: ...") from a traceback.
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^[A-Za-z_][\w.]*(Error|Exception|Warning):\s+/.test(lines[i])) return lines[i];
  }
  return '';
}

/** Read a training Job's status (poll). Never throws — an unreachable API is `unknown`. */
export async function readTrainingJob(
  jobName: string,
  namespace: string,
  client?: K8sClient,
): Promise<TrainingStatus> {
  const k = client ?? (await defaultK8s());
  const res = await k('GET', `/apis/batch/v1/namespaces/${namespace}/jobs/${jobName}`);
  if (res.status === 0 || res.status >= 400) {
    return { jobName, phase: 'unknown', active: false, reason: res.status === 404 ? 'job not found' : 'cluster unreachable' };
  }
  const status = res.body?.status as Record<string, unknown> | undefined;
  const meta = res.body?.metadata as { creationTimestamp?: string } | undefined;
  const phase = jobPhase(status);
  const conditions = (status?.conditions as { message?: string }[] | undefined) ?? [];
  let reason = conditions[conditions.length - 1]?.message ?? phase;
  // A pending Job (no active pod yet) is usually stuck on its pod — surface the
  // pod's own waiting reason (ImagePullBackOff, unschedulable, …) honestly.
  if (phase === 'pending') {
    const podReason = await podPendingReason(jobName, namespace, k);
    if (podReason) reason = podReason;
  }
  return { jobName, phase, active: phase === 'running' || phase === 'pending', reason, createdAt: meta?.creationTimestamp };
}

/**
 * Best-effort MLflow metric read for a COMPLETED run (the honest post-train value). The trainer
 * tags its MLflow run with the Job name (run_name); we look it up and pull the optimize metric.
 * When MLflow is unreachable — or the metric absent — we return {} so `completeTraining` records
 * an honest UNTRACKED version (never invents a number). `mlflowUrl` is injected (no config import
 * here) so this stays test-safe and is shared by BOTH front doors (the train route + the MCP tool).
 */
export async function readMlflowMetric(
  jobName: string,
  metricName: string | undefined,
  mlflowUrl: string,
): Promise<{ runId?: string; value?: number }> {
  if (!metricName || !mlflowUrl) return {};
  try {
    const res = await fetch(`${mlflowUrl}/api/2.0/mlflow/runs/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filter: `tags.mlflow.runName = '${jobName}'`, max_results: 1 }),
      cache: 'no-store',
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return {};
    const data = (await res.json()) as {
      runs?: { info?: { run_id?: string }; data?: { metrics?: { key: string; value: number }[] } }[];
    };
    const run = data.runs?.[0];
    const value = run?.data?.metrics?.find((mm) => mm.key === metricName)?.value;
    return { runId: run?.info?.run_id, value: typeof value === 'number' ? value : undefined };
  } catch {
    return {};
  }
}
