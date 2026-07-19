/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { config } from '@/lib/core/config';
import { trace } from '@/lib/infra/agent-governed';
import {
  ensureModelsHydrated,
  assertCanDeploy,
  assertDeployScope,
  startDeploy,
  completeDeploy,
  failDeploy,
  deployAdapter,
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
 * The governed DEPLOY action for a TRAINED model — creates/reconciles a per-model
 * KServe InferenceService (lib/science/deploy.ts) serving the artifact training
 * uploaded to s3://mlflow/models/<model>, flipping `buildState` trained→deploying.
 * Owner / in-domain admin only; agents rejected by the model-service. An
 * unreachable cluster is an honest 503 — the model is never marked deployed.
 *
 *   POST /api/science/model/<model>/deploy  -> { ok, deploy, model }
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
    await ensureModelsHydrated();
    // Edit-scope + state check BEFORE touching the cluster (fail fast, no side effects).
    const m = assertCanDeploy(model, actor);
    const deploy = await deployAdapter.submit(m.model);
    const updated = startDeploy(model, actor, deploy.isvc);
    await trace({
      principal: user.id,
      tool: 'model_deploy',
      input: { model, storageUri: deploy.storageUri },
      output: { isvc: deploy.isvc, buildState: updated.buildState },
      decision: 'allow',
    });
    return NextResponse.json({ ok: true, deploy, model: updated });
  } catch (e) {
    const status = (e as { status?: number }).status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}

/**
 * Poll the model's in-flight deploy and ADVANCE the state machine (mirrors the
 * train poll):
 *   • progressing → report progress (no state change);
 *   • ready       → completeDeploy (deploying→deployed);
 *   • failed      → failDeploy (deploying→deploy_failed; record the reason).
 * `unknown` (cluster unreachable) keeps polling — never a fake success/failure.
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
    await ensureModelsHydrated();
    const m = assertDeployScope(model, actor);
    if (m.buildState !== 'deploying') {
      return NextResponse.json({ ok: true, phase: m.buildState ?? 'draft', model: m });
    }
    const status = await deployAdapter.poll(model);
    if (status.phase === 'ready') {
      const updated = completeDeploy(model, actor);
      return NextResponse.json({ ok: true, phase: 'deployed', status, model: updated });
    }
    if (status.phase === 'failed') {
      const updated = failDeploy(model, actor, status.reason);
      return NextResponse.json({ ok: true, phase: 'deploy_failed', status, model: updated });
    }
    return NextResponse.json({ ok: true, phase: 'deploying', status, model: m });
  } catch (e) {
    const status = (e as { status?: number }).status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
