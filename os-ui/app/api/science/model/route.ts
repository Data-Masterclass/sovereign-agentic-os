/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { config } from '@/lib/core/config';
import { trace } from '@/lib/infra/agent-governed';
import {
  listModelsForUser,
  getModel,
  createModel,
  ensureModelsHydrated,
  compilePredictPolicy,
  goLive,
  importModel,
  featuresAdapter,
  trainTrackAdapter,
  registryAdapter,
  deployAdapter,
  monitoringAdapter,
  CHURN,
  type Actor,
  type ConsumptionMode,
  type ModelSpecInput,
  type ServiceModel,
} from '@/lib/science';
import { promoteThroughSeam } from '@/lib/governance/ladder';

export const dynamic = 'force-dynamic';

function disabled() {
  return NextResponse.json(
    { mlEnabled: false, models: [], mine: [], domain: [], marketplace: [], adapters: [] },
    { status: 200 },
  );
}

function actorFrom(user: { id: string; role: string; domains: string[] }): Actor {
  // Map the platform Role onto the model-service Actor role, PRESERVING domain_admin
  // so the shared edit-scope rule grants it manage rights on in-domain models. Only
  // the base creator collapses to 'user'. A human acting from the UI — NEVER an agent.
  const role: Actor['role'] =
    user.role === 'admin' ? 'admin'
    : user.role === 'domain_admin' ? 'domain_admin'
    : user.role === 'builder' ? 'builder'
    : 'user';
  return { id: user.id, role, domains: user.domains, isAgent: false };
}

/**
 * Model-as-service state for the Science tab: the deployed models the VIEWER is
 * entitled to (RLS-scoped via `listModelsForUser` — their Personal models + their
 * domains' Domain models + Marketplace-published models, never another domain's or
 * another user's Personal model), each with its compiled callable-scope policy
 * (proving promotion/certification widens reach) and the adapter liveness probes.
 * Real per-model prediction usage rides on each model record. Off when `ml.enabled=false`.
 */
export async function GET(request: Request) {
  if (!config.mlEnabled) return disabled();
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 401 });
  }
  // Durable registry: hydrate persisted models. A fresh tenant is EMPTY — there is no
  // fabricated churn seed (removed in Phase A); models are earned via create/train.
  await ensureModelsHydrated();

  const [features, train, registry, deploy, mon] = await Promise.all([
    featuresAdapter.probe(),
    trainTrackAdapter.probe(),
    registryAdapter.probe(),
    deployAdapter.probe(),
    monitoringAdapter.probe(),
  ]);
  const withPolicy = (m: ServiceModel) => ({ ...m, policy: compilePredictPolicy(m) });
  // ?archived=1 additionally returns soft-archived models (their own section).
  const includeArchived = new URL(request.url).searchParams.get('archived') === '1';
  const models = listModelsForUser({ id: user.id, domains: user.domains }, { includeArchived }).map(withPolicy);
  // Group into the OS-wide { mine, domain, marketplace } shape the scope helper needs.
  // "mine" = tier Personal (owner-only visibility); Domain/Marketplace by tier.
  const groups = {
    mine: models.filter((m) => m.tier === 'Personal'),
    domain: models.filter((m) => m.tier === 'Domain'),
    marketplace: models.filter((m) => m.tier === 'Marketplace'),
  };
  return NextResponse.json({
    mlEnabled: true,
    gpuEnabled: false, // CPU default; GPU behind Builder/Admin approval + quota
    models, // flat (back-compat: existing consumers read models[0]); each carries real `usage`
    ...groups, // grouped (the tab's scope switcher)
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

  let body: {
    op?: string;
    model?: string;
    mode?: ConsumptionMode;
    name?: string;
    description?: string;
    // Simple-mode: algorithm/optimizeMetric/trainTestSplit optional (server fills defaults).
    spec?: ModelSpecInput;
  } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }
  const model = (body.model ?? CHURN.model).toString();
  const actor = actorFrom(user);

  try {
    await ensureModelsHydrated(); // durable registry: act on the persisted state
    switch (body.op) {
      case 'create': {
        if (!body.name || !body.spec) {
          return NextResponse.json({ error: 'create needs a name and a spec' }, { status: 400 });
        }
        const m = createModel({ name: body.name, description: body.description, spec: body.spec }, actor);
        await trace({ principal: user.id, tool: 'model_create', input: { name: m.name, model: m.model }, output: { tier: m.tier, buildState: m.buildState }, decision: 'allow' });
        return NextResponse.json({ ok: true, model: m, policy: compilePredictPolicy(m) });
      }
      case 'promote': {
        // Route the tier flip THROUGH the governance effect seam (never a direct
        // promoteModel — the former back door is closed). The seam's applier
        // re-enforces the Builder+domain gate. Intent = promote (rung 1): a mismatch
        // with the model's tier is a typed conflict, never a silent certify.
        await promoteThroughSeam('model', model, user, { rung: 'promote' });
        const m = getModel(model)!;
        await trace({ principal: user.id, tool: 'model_promote', input: { model }, output: { tier: m.tier }, decision: 'allow' });
        return NextResponse.json({ ok: true, model: m, policy: compilePredictPolicy(m) });
      }
      case 'go-live': {
        // go-live is a STAGE move (Staging→Production), orthogonal to the tier
        // ladder — it does not share/promote an artifact, so it stays direct.
        const m = goLive(model, actor);
        await trace({ principal: user.id, tool: 'model_go_live', input: { model }, output: { stage: m.stage }, decision: 'allow' });
        return NextResponse.json({ ok: true, model: m });
      }
      case 'certify': {
        const mode: ConsumptionMode = body.mode === 'fork-allowed' ? 'fork-allowed' : 'read-in-place';
        // Certification (Domain→Marketplace) THROUGH the seam (never a direct
        // certifyModel). Intent = certify (rung 2); a mismatch is a typed conflict.
        await promoteThroughSeam('model', model, user, { mode, rung: 'certify' });
        const m = getModel(model)!;
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
        // Retrain is NOT wired. The old path returned a FABRICATED `dagster-retrain-<ts>` runId
        // WITHOUT ever calling Dagster (traced as allow) — an honesty violation, removed. A real
        // governed retrain trigger is Phase-B work. Answer honestly rather than invent a run.
        return NextResponse.json(
          { error: 'Retrain is not wired yet — no Dagster retrain is triggered. This will return once a real, governed retrain trigger ships.' },
          { status: 410 },
        );
      }
      default:
        return NextResponse.json({ error: `unknown op ${body.op}` }, { status: 400 });
    }
  } catch (e) {
    const status = (e as { status?: number }).status ?? 400;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
