/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { config } from '@/lib/core/config';
import { trace } from '@/lib/infra/agent-governed';
import {
  getModel,
  assertCanTrain,
  startTraining,
  completeTraining,
  failTraining,
  startDeploy,
  computeLaunchStatus,
  ensureModelsHydrated,
  trainTrackAdapter,
  deployAdapter,
  readMlflowMetric,
  type Actor,
  type ServiceModel,
} from '@/lib/science';

export const dynamic = 'force-dynamic';

/** A Job whose POD has not started after this long is failed honestly (ImagePullBackOff etc). */
const PENDING_DEADLINE_MS = 10 * 60_000;

/**
 * FUSED "Train & launch": on a successful training run, auto-submit the deploy so the model
 * flows trained → deploying WITHOUT a second user action (auto-deploy is the Simple default).
 * The deploy poll (GET .../deploy) then carries deploying → deployed honestly. A cluster that
 * refuses the deploy submit does NOT fail the training result — training genuinely succeeded;
 * the model rests at `trained` with the deploy error recorded, so Developer view can retry the
 * standalone deploy. Returns the model AFTER the (attempted) fusion.
 */
async function fuseDeploy(model: string, actor: Actor, trained: ServiceModel, principal: string): Promise<ServiceModel> {
  try {
    const deploy = await deployAdapter.submit(trained.model);
    const deploying = startDeploy(model, actor, deploy.isvc);
    await trace({
      principal,
      tool: 'model_deploy',
      input: { model, storageUri: deploy.storageUri, fused: true },
      output: { isvc: deploy.isvc, buildState: deploying.buildState },
      decision: 'allow',
    });
    return deploying;
  } catch {
    // Honest: training succeeded; the deploy submit did not. Leave the model `trained`
    // (the standalone Deploy route + Developer retry path handles it) — never fake a deploy.
    return getModel(model) ?? trained;
  }
}

/** A human (never an agent) Actor from the session, preserving domain_admin. */
function actorFrom(user: { id: string; role: string; domains: string[] }): Actor {
  const role: Actor['role'] =
    user.role === 'admin' ? 'admin'
    : user.role === 'domain_admin' ? 'domain_admin'
    : user.role === 'builder' ? 'builder'
    : 'user';
  return { id: user.id, role, domains: user.domains, isAgent: false };
}

/**
 * The governed TRAIN action for a model — a run-as-user, edit-scoped submit of a
 * per-model training Job (lib/science/training.ts) for the model's spec, flipping
 * `buildState` draft→training. The Job reads the governed Gold product THROUGH
 * Trino as a least-privilege read principal (never the caller's write identity,
 * never a widened grant) and uploads a KServe-servable artifact. Owner / in-domain
 * admin only; agents rejected by the model-service.
 *
 *   POST /api/science/model/<model>/train  -> { ok, run, model }
 */
export async function POST(_req: Request, ctx: { params: Promise<{ model: string }> }) {
  if (!config.mlEnabled) return NextResponse.json({ error: 'Science (Layer 4) is off' }, { status: 404 });
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 401 });
  }
  const { model } = await ctx.params;
  const actor = actorFrom(user);
  try {
    await ensureModelsHydrated(); // durable registry: act on the persisted state
    // Edit-scope + spec check BEFORE touching the cluster (fail fast, no side effects).
    const m = assertCanTrain(model, actor);
    const run = await trainTrackAdapter.submit(m.model, m.spec!);
    const updated = startTraining(model, actor, { jobName: run.jobName, namespace: run.namespace });
    await trace({
      principal: user.id,
      tool: 'model_train',
      input: { model, source: m.spec!.sourceDataProductFqn, task: m.spec!.taskType },
      output: { jobName: run.jobName, buildState: updated.buildState },
      decision: 'allow',
    });
    return NextResponse.json({ ok: true, run, model: updated, launch: computeLaunchStatus(updated) });
  } catch (e) {
    const status = (e as { status?: number }).status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}

/**
 * Poll the model's in-flight training run and ADVANCE the state machine:
 *   • running/pending → report progress (no state change);
 *   • succeeded       → completeTraining (training→trained; register version + metric);
 *   • failed          → failTraining (training→draft; record the reason).
 * The metric is read from MLflow if reachable; otherwise the version is honest
 * about being untracked (metric 0). Owner / in-domain admin only.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ model: string }> }) {
  if (!config.mlEnabled) return NextResponse.json({ error: 'Science (Layer 4) is off' }, { status: 404 });
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 401 });
  }
  const { model } = await ctx.params;
  const actor = actorFrom(user);
  try {
    await ensureModelsHydrated(); // durable registry: act on the persisted state
    const m = assertCanTrain(model, actor);
    if (m.buildState !== 'training' || !m.trainingJob || !m.trainingNamespace) {
      // Not polling a live run: report the fused launch status derived from the settled state.
      return NextResponse.json({ ok: true, phase: m.buildState ?? 'draft', model: m, launch: computeLaunchStatus(m) });
    }
    const status = await trainTrackAdapter.poll(m.trainingJob, m.trainingNamespace);
    // HONEST endings for "pending forever": a Job that vanished (TTL/manual delete)
    // or whose pod never started within the deadline is a real failure — surface
    // it (with the pod's waiting reason, e.g. ImagePullBackOff) instead of
    // spinning. `cluster unreachable` keeps polling (no false failure).
    if (status.phase === 'unknown' && status.reason === 'job not found') {
      const updated = failTraining(model, actor, 'training job not found on the cluster (deleted or expired) — re-run Train');
      return NextResponse.json({ ok: true, phase: 'failed', status, model: updated, launch: computeLaunchStatus(updated) });
    }
    if (status.phase === 'pending' && status.createdAt) {
      const age = Date.now() - Date.parse(status.createdAt);
      if (Number.isFinite(age) && age > PENDING_DEADLINE_MS) {
        const why = status.reason && status.reason !== 'pending' ? ` — ${status.reason}` : '';
        const updated = failTraining(model, actor, `training pod did not start within ${Math.round(PENDING_DEADLINE_MS / 60000)} minutes${why}`);
        return NextResponse.json({ ok: true, phase: 'failed', status, model: updated, launch: computeLaunchStatus(updated) });
      }
    }
    if (status.phase === 'succeeded') {
      const metric = await readMlflowMetric(m.trainingJob, m.spec?.optimizeMetric, config.mlflowUrl);
      const trained = completeTraining(model, actor, {
        runId: metric.runId ?? m.trainingJob,
        metric: metric.value,
        metricName: m.spec?.optimizeMetric,
      });
      // FUSED launch: auto-submit the deploy so "Train & launch" is ONE action (Simple default).
      const updated = await fuseDeploy(model, actor, trained, user.id);
      return NextResponse.json({ ok: true, phase: 'succeeded', status, model: updated, launch: computeLaunchStatus(updated) });
    }
    if (status.phase === 'failed') {
      const updated = failTraining(model, actor, status.reason);
      return NextResponse.json({ ok: true, phase: 'failed', status, model: updated, launch: computeLaunchStatus(updated) });
    }
    return NextResponse.json({ ok: true, phase: status.phase, status, model: m, launch: computeLaunchStatus(m, `${status.phase}${status.reason ? ` — ${status.reason}` : ''}`) });
  } catch (e) {
    const status = (e as { status?: number }).status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
