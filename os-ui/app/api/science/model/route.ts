/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { config } from '@/lib/config';
import { trace } from '@/lib/agent-governed';
import {
  listModels,
  getModel,
  compilePredictPolicy,
  promoteModel,
  goLive,
  certifyModel,
  importModel,
  featuresAdapter,
  trainTrackAdapter,
  registryAdapter,
  deployAdapter,
  monitoringAdapter,
  CHURN,
  type Actor,
  type ConsumptionMode,
} from '@/lib/science';

export const dynamic = 'force-dynamic';

function disabled() {
  return NextResponse.json({ mlEnabled: false, models: [], adapters: [], drift: null }, { status: 200 });
}

function actorFrom(user: { id: string; role: string; domains: string[] }): Actor {
  // Map the platform Role (participant|builder|admin) onto the model-service
  // Actor role (user|builder|admin). A human acting from the UI — NEVER an agent.
  const role: Actor['role'] = user.role === 'builder' ? 'builder' : user.role === 'admin' ? 'admin' : 'user';
  return { id: user.id, role, domains: user.domains, isAgent: false };
}

/**
 * Model-as-service state for the Science tab: every deployed model with its
 * compiled callable-scope policy (proving promotion/certification widens reach),
 * the 5 adapter liveness probes, and the churn drift series for the monitoring
 * view. Off (and empty) when `ml.enabled=false`.
 */
export async function GET() {
  if (!config.mlEnabled) return disabled();
  const [features, train, registry, deploy, mon, drift] = await Promise.all([
    featuresAdapter.probe(),
    trainTrackAdapter.probe(),
    registryAdapter.probe(),
    deployAdapter.probe(),
    monitoringAdapter.probe(),
    monitoringAdapter.drift(),
  ]);
  const models = listModels().map((m) => ({ ...m, policy: compilePredictPolicy(m) }));
  return NextResponse.json({
    mlEnabled: true,
    gpuEnabled: false, // CPU default; GPU behind Builder/Admin approval + quota
    models,
    drift,
    adapters: [
      { name: featuresAdapter.name, kind: 'features', live: features },
      { name: trainTrackAdapter.name, kind: 'train/track', live: train },
      { name: registryAdapter.name, kind: 'registry', live: registry },
      { name: deployAdapter.name, kind: 'deploy', live: deploy },
      { name: monitoringAdapter.name, kind: 'monitoring', live: mon },
    ],
  });
}

/**
 * Model-as-service mutations — ALL human Builder/Admin gated (the route builds a
 * non-agent Actor; an agent calling this still cannot certify/go-live/promote
 * because `model-service` rejects agent actors AND there is no agent identity
 * here). Ops: promote (Personal→Domain), go-live (Staging→Production), certify
 * (Domain→Marketplace + consumption mode), import (marketplace consumption),
 * retrain (Dagster trigger).
 */
export async function POST(req: Request) {
  if (!config.mlEnabled) {
    return NextResponse.json({ error: 'Science (Layer 4) is off' }, { status: 404 });
  }
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 401 });
  }

  let body: { op?: string; model?: string; mode?: ConsumptionMode } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }
  const model = (body.model ?? CHURN.model).toString();
  const actor = actorFrom(user);

  try {
    switch (body.op) {
      case 'promote': {
        const m = promoteModel(model, actor);
        await trace({ principal: user.id, tool: 'model_promote', input: { model }, output: { tier: m.tier }, decision: 'allow' });
        return NextResponse.json({ ok: true, model: m, policy: compilePredictPolicy(m) });
      }
      case 'go-live': {
        const m = goLive(model, actor);
        await trace({ principal: user.id, tool: 'model_go_live', input: { model }, output: { stage: m.stage }, decision: 'allow' });
        return NextResponse.json({ ok: true, model: m });
      }
      case 'certify': {
        const mode: ConsumptionMode = body.mode === 'fork-allowed' ? 'fork-allowed' : 'read-in-place';
        const m = certifyModel(model, actor, mode);
        await trace({ principal: user.id, tool: 'model_certify', input: { model, mode }, output: { tier: m.tier }, decision: 'allow' });
        return NextResponse.json({ ok: true, model: m, policy: compilePredictPolicy(m) });
      }
      case 'import': {
        const src = getModel(model);
        const r = importModel(model, { id: user.id, domain: user.domains[0] ?? 'marketing' });
        await trace({ principal: user.id, tool: 'model_import', input: { model, consumptionMode: src?.consumptionMode }, output: { mode: r.mode }, decision: 'allow' });
        return NextResponse.json({ ok: true, import: r });
      }
      case 'retrain': {
        const r = await monitoringAdapter.triggerRetrain(model);
        await trace({ principal: user.id, tool: 'model_retrain', input: { model }, output: { runId: r.runId }, decision: 'allow' });
        return NextResponse.json({ ok: true, retrain: r });
      }
      default:
        return NextResponse.json({ error: `unknown op ${body.op}` }, { status: 400 });
    }
  } catch (e) {
    const status = (e as { status?: number }).status ?? 400;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
