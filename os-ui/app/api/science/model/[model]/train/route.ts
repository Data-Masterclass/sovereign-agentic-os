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
  trainTrackAdapter,
  type Actor,
} from '@/lib/science';

export const dynamic = 'force-dynamic';

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
    return NextResponse.json({ ok: true, run, model: updated });
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
    const m = assertCanTrain(model, actor);
    if (m.buildState !== 'training' || !m.trainingJob || !m.trainingNamespace) {
      return NextResponse.json({ ok: true, phase: m.buildState ?? 'draft', model: m });
    }
    const status = await trainTrackAdapter.poll(m.trainingJob, m.trainingNamespace);
    if (status.phase === 'succeeded') {
      const metric = await readMlflowMetric(m.trainingJob, m.spec?.optimizeMetric);
      const updated = completeTraining(model, actor, {
        runId: metric.runId ?? m.trainingJob,
        metric: metric.value,
        metricName: m.spec?.optimizeMetric,
      });
      return NextResponse.json({ ok: true, phase: 'succeeded', status, model: updated });
    }
    if (status.phase === 'failed') {
      const updated = failTraining(model, actor, status.reason);
      return NextResponse.json({ ok: true, phase: 'failed', status, model: updated });
    }
    return NextResponse.json({ ok: true, phase: status.phase, status, model: m });
  } catch (e) {
    const status = (e as { status?: number }).status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}

/**
 * Best-effort MLflow metric read for a completed run. The trainer tags its run
 * with the job name (run_name); we look it up and pull the optimize metric. When
 * MLflow is unreachable we return no value so `completeTraining` records an honest
 * untracked version rather than inventing a number.
 */
async function readMlflowMetric(
  jobName: string,
  metricName?: string,
): Promise<{ runId?: string; value?: number }> {
  if (!metricName) return {};
  try {
    const res = await fetch(`${config.mlflowUrl}/api/2.0/mlflow/runs/search`, {
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
