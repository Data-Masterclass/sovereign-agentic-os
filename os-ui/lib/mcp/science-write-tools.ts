/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/core/auth';
import type { McpTool } from './server';
import { P, fail, str, strArr } from './discovery-common';
import { config } from '@/lib/core/config';
import { trace } from '@/lib/infra/agent-governed';
import {
  createModel,
  getModel,
  assertCanTrain,
  startTraining,
  completeTraining,
  failTraining,
  startDeploy,
  completeDeploy,
  failDeploy,
  computeLaunchStatus,
  ensureModelsHydrated,
  validateDefinition,
  trainTrackAdapter,
  deployAdapter,
  readMlflowMetric,
  type Actor,
  type ModelSpecInput,
  type ServiceModel,
  type TaskType,
} from '@/lib/science';

/**
 * THE SCIENCE WRITE MCP SURFACE (Phase D) — MCP parity for the full Science journey
 * an external agent can now carry end-to-end WITHOUT the UI: create_model →
 * train_model (fused launch) → get_model_status (poll) → science_predict → promote.
 *
 * Each tool is a THIN adapter over the EXACT SAME governed model-service functions
 * the Science tab + `/api/science/*` routes call, under the caller's own identity —
 * so the tier ladder, edit-scope gate, honest-refusal-of-unsupported-algorithms and
 * Langfuse trace all apply UNCHANGED (mirrors define_metric / create_dataset). There
 * is NO privileged path: identity comes from the session, never the request body.
 *
 * HONESTY invariants inherited from the routes:
 *   • ml.enabled=false → these tools 404 (nothing to train/serve), same as the routes.
 *   • create_model VALIDATES the dataset/target/features against the caller's REAL,
 *     RLS-scoped feed (validateDefinition) — a hallucinated dataset or column is
 *     REFUSED by name, never silently accepted.
 *   • Simple defaults (algorithm/optimizeMetric/split) are filled by normalizeSpec; a
 *     supplied algorithm the runtime can't train is refused there, never substituted.
 *   • get_model_status ADVANCES the same state machine the train/deploy poll routes do
 *     (train→trained, fuse the deploy, deploying→deployed) — it never fabricates a phase.
 */

/**
 * The caller acts on their OWN model AS a human (never an agent): the same run-as-user
 * posture every write door uses. The model-service `assertHuman` invariant guards
 * certify/go-live/promote (not reachable here); create/train run as the session user
 * exactly like the UI route's `actorFrom`, preserving domain_admin for the edit-scope gate.
 */
function actorFrom(user: CurrentUser): Actor {
  const role: Actor['role'] =
    user.role === 'admin' ? 'admin'
    : user.role === 'domain_admin' ? 'domain_admin'
    : user.role === 'builder' ? 'builder'
    : 'user';
  return { id: user.id, role, domains: user.domains, isAgent: false };
}

/** The problem kinds this CPU runtime can actually train (the honest capability set). */
const TRAINABLE_TASKS: TaskType[] = ['binary_classification', 'multiclass_classification', 'regression'];

/** A plain-language reason for the current build phase — what get_model_status leads with. */
function phaseReason(m: ServiceModel): string {
  switch (m.buildState ?? 'draft') {
    case 'draft':
      return m.lastTrainingError
        ? `The last training run failed (${m.lastTrainingError}). Call train_model to retry.`
        : 'Not trained yet — call train_model to train and launch it.';
    case 'training':
      return 'Training is in flight. Keep polling get_model_status; it will fuse the deploy automatically when training succeeds.';
    case 'trained':
      return 'Training finished; publishing (deploy) is being submitted. Poll again to advance it.';
    case 'deploying':
      return 'Publishing — the model is being deployed to serving. Poll again until it is live.';
    case 'deployed':
      return 'Live — the model is deployed and callable via science_predict (subject to the tier ladder).';
    case 'deploy_failed':
      return `Publishing failed (${m.lastDeployError ?? 'unknown reason'}).`;
    case 'archived':
      return 'This model is archived.';
  }
}

/** The trained metric (name + value) once a run has completed, else null (never fabricated). */
function trainedMetric(m: ServiceModel): { name: string; value: number } | null {
  if (typeof m.metrics?.primary === 'number') {
    return { name: m.metrics.primaryMetric ?? m.spec?.optimizeMetric ?? 'metric', value: m.metrics.primary };
  }
  return null;
}

/**
 * FUSED "Train & launch" — on a successful training run, auto-submit the deploy so the model
 * flows trained → deploying with NO second action (the Simple default). Mirrors the train
 * route's `fuseDeploy`: a cluster that refuses the deploy does NOT undo the genuine training
 * success — the model rests at `trained` with the deploy error recorded. Never fakes a deploy.
 */
async function fuseDeploy(model: string, actor: Actor, trained: ServiceModel, principal: string): Promise<ServiceModel> {
  try {
    const deploy = await deployAdapter.submit(trained.model);
    const deploying = startDeploy(model, actor, deploy.isvc);
    await trace({ principal, tool: 'model_deploy', input: { model, storageUri: deploy.storageUri, fused: true }, output: { isvc: deploy.isvc, buildState: deploying.buildState }, decision: 'allow' });
    return deploying;
  } catch {
    return getModel(model) ?? trained;
  }
}

export const scienceWriteTools: McpTool[] = [
  {
    name: 'create_model',
    tab: 'science',
    minRole: 'creator',
    description:
      'Create (define) a governed ML model as a draft in YOUR domain — the Define step of the Science golden path, done from an agent. You name it, pick a dataset you can see, the target column to predict and (optionally) the feature columns; the server fills the Simple defaults (it chooses the algorithm, optimize metric and train/test split — you never tune them). Path: step 1 of building a model (guide: sovereign-os://guide/path/science). Before: list_datasets / whoami. After: train_model, then get_model_status, then science_predict. HONESTY: the dataset, target and features are VALIDATED against your real, RLS-scoped data — a dataset you cannot see or a column that does not exist is REFUSED by name, never invented. This CPU runtime trains classification and regression only (no forecasting/clustering). Returns the model card + the next step. 404 when ml.enabled=false.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Human name for the model, e.g. "Churn risk".' },
        goal: { type: 'string', description: 'Optional one-line business goal (recorded as the description), e.g. "flag accounts likely to churn".' },
        dataset: { type: 'string', description: 'The id of a dataset you can see (from list_datasets), e.g. "ds_ab12cd". Validated — a dataset you cannot see is refused.' },
        target: { type: 'string', description: 'The real column to predict, e.g. "churned". Must exist in the dataset (validated).' },
        features: { type: 'array', items: { type: 'string' }, description: 'Optional feature columns to learn from (2–8 real columns other than the target). Validated; invented columns are dropped/refused.' },
        taskType: { type: 'string', enum: ['binary_classification', 'multiclass_classification', 'regression'], description: 'Optional problem kind (default binary_classification). This runtime supports classification and regression only.' },
      },
      required: ['name', 'dataset', 'target'],
      examples: [
        { name: 'Churn risk', dataset: 'ds_ab12cd', target: 'churned', features: ['recency_days', 'order_frequency', 'monetary_value'] },
        { name: 'Deal size', goal: 'predict expected deal value', dataset: 'ds_ef34gh', target: 'amount', taskType: 'regression' },
      ],
    },
    call: async (user, args) => {
      if (!config.mlEnabled) fail('Science (Layer 4) is off — set ml.enabled=true to create models', 404);
      const name = str(args.name).trim();
      if (!name) fail('create_model needs a `name`', 400);
      const dataset = str(args.dataset).trim();
      if (!dataset) fail('create_model needs a `dataset` id (from list_datasets)', 400);
      const target = str(args.target).trim();
      if (!target) fail('create_model needs a `target` column to predict', 400);
      const taskInput = str(args.taskType).trim();
      const taskType: TaskType = TRAINABLE_TASKS.includes(taskInput as TaskType) ? (taskInput as TaskType) : 'binary_classification';

      await ensureModelsHydrated();
      // Ground the definition against the caller's REAL feed — refuse a hallucinated
      // dataset/column WITH the honest reason (the same server-side gate the Design assistant uses).
      const validated = await validateDefinition(
        { datasetId: dataset, targetColumn: target, features: strArr(args.features) },
        P(user),
      );
      if ('error' in validated) fail(`Cannot create the model — it ${validated.error}. Use list_datasets to pick a real dataset and column.`, 400);
      const def = validated.definition;

      const spec: ModelSpecInput = {
        sourceDataProductFqn: def.datasetFqn,
        sourceDatasetId: def.datasetId,
        targetColumn: def.targetColumn ?? target,
        taskType,
        features: def.features,
      };
      // createModel applies the Simple defaults (normalizeSpec) + refuses an unsupported algorithm.
      const m = createModel({ name, description: str(args.goal).trim() || undefined, spec }, actorFrom(user));
      await trace({ principal: user.id, tool: 'model_create', input: { name: m.name, model: m.model, dataset: def.datasetId, target: spec.targetColumn }, output: { tier: m.tier, buildState: m.buildState }, decision: 'allow' });
      return {
        ok: true,
        model: { model: m.model, name: m.name, tier: m.tier, buildState: m.buildState, spec: m.spec },
        nextStep: `Call train_model { model: "${m.model}" } to train and launch it.`,
      };
    },
  },
  {
    name: 'train_model',
    tab: 'science',
    minRole: 'creator',
    description:
      'Train a model you own and LAUNCH it — the fused "Train & launch" (one action reads the data, trains, then auto-publishes/deploys). This SUBMITS the training run and returns immediately with a run handle + the launch status; it does NOT block until done. Path: step 2 of building a model. Before: create_model. After: poll get_model_status until phase="deployed" (it advances training→trained→deploying→deployed for you), then science_predict. Governance: owner / in-domain admin only (the same edit-scope gate as the tab); runs as YOU, audited. HONESTY: a real per-model Job is submitted; an unreachable cluster is a real error, never a fake success. 404 when ml.enabled=false; a model with no spec / already-in-flight run is a typed error.',
    inputSchema: {
      type: 'object',
      properties: { model: { type: 'string', description: 'The registry model name from create_model / list_models, e.g. "churn_risk".' } },
      required: ['model'],
      examples: [{ model: 'churn_risk' }],
    },
    call: async (user, args) => {
      if (!config.mlEnabled) fail('Science (Layer 4) is off — set ml.enabled=true to train models', 404);
      const model = str(args.model).trim();
      if (!model) fail('train_model needs a `model` (from create_model / list_models)', 400);
      const actor = actorFrom(user);
      await ensureModelsHydrated();
      // Edit-scope + spec check BEFORE touching the cluster (fail fast, no side effects).
      const m = assertCanTrain(model, actor);
      const run = await trainTrackAdapter.submit(m.model, m.spec!);
      const updated = startTraining(model, actor, { jobName: run.jobName, namespace: run.namespace });
      await trace({ principal: user.id, tool: 'model_train', input: { model, source: m.spec!.sourceDataProductFqn, task: m.spec!.taskType }, output: { jobName: run.jobName, buildState: updated.buildState }, decision: 'allow' });
      return {
        ok: true,
        run: { jobName: run.jobName, namespace: run.namespace },
        launch: computeLaunchStatus(updated),
        nextStep: `Poll get_model_status { model: "${model}" } until phase="deployed".`,
      };
    },
  },
  {
    name: 'get_model_status',
    tab: 'science',
    minRole: 'creator',
    description:
      'Poll a model’s fused launch and ADVANCE it — the step that lets an agent carry the whole journey. Reports the launch status (the read → train → publish timeline), a plain-language reason for the current phase, and the real trained metric (name + value) once available. When a training run is in flight this DRIVES the state machine exactly as the Science tab does: training→trained (registering the version + real metric), then auto-fuses the deploy, then deploying→deployed. Path: step 3 of building a model. Before: train_model. After: repeat until phase="deployed", then science_predict. Governance: owner / in-domain admin only. HONESTY: phases are read from the real Job / InferenceService — a metric is stated only once a run actually produced it (never fabricated); an unreachable cluster keeps polling rather than faking an outcome. 404 when ml.enabled=false.',
    inputSchema: {
      type: 'object',
      properties: { model: { type: 'string', description: 'The registry model name to poll, e.g. "churn_risk".' } },
      required: ['model'],
      examples: [{ model: 'churn_risk' }],
    },
    call: async (user, args) => {
      if (!config.mlEnabled) fail('Science (Layer 4) is off — set ml.enabled=true', 404);
      const model = str(args.model).trim();
      if (!model) fail('get_model_status needs a `model`', 400);
      const actor = actorFrom(user);
      await ensureModelsHydrated();
      let m = assertCanTrain(model, actor); // owner / in-domain admin edit-scope + existence

      // Advance an in-flight TRAINING run (mirrors the train-poll route), then fuse the deploy.
      if (m.buildState === 'training' && m.trainingJob && m.trainingNamespace) {
        const status = await trainTrackAdapter.poll(m.trainingJob, m.trainingNamespace);
        if (status.phase === 'succeeded') {
          // Read the REAL metric from MLflow (shared reader) — an unreachable MLflow yields an
          // honest UNTRACKED version (metric 0), never a fabricated number, exactly as the route does.
          const metric = await readMlflowMetric(m.trainingJob, m.spec?.optimizeMetric, config.mlflowUrl);
          const trained = completeTraining(model, actor, { runId: metric.runId ?? m.trainingJob, metric: metric.value, metricName: m.spec?.optimizeMetric });
          m = await fuseDeploy(model, actor, trained, user.id);
        } else if (status.phase === 'failed') {
          m = failTraining(model, actor, status.reason);
        } else if (status.phase === 'unknown' && status.reason === 'job not found') {
          m = failTraining(model, actor, 'training job not found on the cluster (deleted or expired) — re-run train_model');
        }
      } else if (m.buildState === 'deploying') {
        // Advance an in-flight DEPLOY (mirrors the deploy-poll route).
        const status = await deployAdapter.poll(model);
        if (status.phase === 'ready') m = completeDeploy(model, actor);
        else if (status.phase === 'failed') m = failDeploy(model, actor, status.reason);
      }

      return {
        ok: true,
        model: m.model,
        phase: m.buildState ?? 'draft',
        reason: phaseReason(m),
        launch: computeLaunchStatus(m),
        metric: trainedMetric(m),
      };
    },
  },
];
