/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { trace } from '@/lib/infra/agent-governed';
import { authorizePredict, ensureModelsHydrated, getModel } from './model-service.ts';
import { predictTool, CHURN, DEFAULT_FEATURES, type ChurnFeatures } from './churn.ts';
import { isvcServiceUrl } from './deploy.ts';
import type { ServiceModel } from './types.ts';

/**
 * The governed `predict` service body, shared by BOTH front doors:
 *   • REST API  (Software apps / external) — `app/api/science/predict/rest`
 *   • MCP tool  (agents)                   — `app/api/science/predict`
 *
 * Both run the SAME governance — `authorizePredict` (tier scope + OPA tool grant)
 * then a Langfuse trace — so the two doors can never diverge. GENERIC: `model`
 * selects ANY registered model (default: the churn slice for back-compat); a
 * non-churn model is scored against its OWN per-model KServe InferenceService
 * (the one the Deploy step created), with an HONEST 502 when its endpoint is
 * unreachable and a 409 when it is not deployed yet.
 */

export type ServeResult = {
  status: number;
  body: Record<string, unknown>;
};

/** KServe v2 infer against a model's own predictor Service (spec-ordered features). */
async function inferOwnService(
  m: ServiceModel,
  features: Record<string, number>,
): Promise<{ ok: true; score: number } | { ok: false; reason: string }> {
  const names = m.spec?.features ?? [];
  const payload = {
    inputs: [
      {
        name: 'input-0',
        shape: [1, names.length],
        datatype: 'FP32',
        data: names.map((k) => Number(features[k] ?? 0)),
      },
    ],
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  try {
    const res = await fetch(`${isvcServiceUrl(m.model)}/v2/models/${m.model}/infer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
      cache: 'no-store',
    });
    if (!res.ok) return { ok: false, reason: `serving endpoint answered ${res.status}` };
    const data = (await res.json()) as { outputs?: { data?: number[] }[] };
    const raw = data?.outputs?.[0]?.data?.[0];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      return { ok: false, reason: 'serving endpoint returned no numeric output' };
    }
    return { ok: true, score: raw };
  } catch {
    return { ok: false, reason: 'serving endpoint unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

function bandFor(score: number): 'low' | 'medium' | 'high' {
  if (score >= 0.66) return 'high';
  if (score >= 0.33) return 'medium';
  return 'low';
}

export async function servePredict(opts: {
  /** Registry model id to score (defaults to the churn slice — back-compat). */
  model?: string;
  account?: string;
  features?: Partial<ChurnFeatures> | Record<string, number>;
  principal: string;
  /** The caller's domain(s) — DERIVED FROM THE SESSION, never the request body. */
  domains: string[];
  isAgent: boolean;
  requestedBy?: string;
}): Promise<ServeResult> {
  await ensureModelsHydrated();
  const modelId = (opts.model ?? CHURN.model).toString();
  const account = (opts.account ?? '').toString();
  const caller = { principal: opts.principal, domains: opts.domains, isAgent: opts.isAgent };

  const authz = await authorizePredict(modelId, caller);
  const common = {
    tool: 'predict',
    model: modelId,
    principal: opts.principal,
    frontDoor: authz.frontDoor,
    tier: authz.policy.tier,
    policy: authz.toolPolicy,
    decision: authz.decision,
    reason: authz.reason,
  };

  if (authz.decision === 'deny') {
    const tr = await trace({ principal: opts.principal, tool: 'predict', input: { account, model: modelId, frontDoor: authz.frontDoor }, output: { denied: authz.reason }, decision: 'deny' });
    return { status: 403, body: { ...common, traceId: tr.id } };
  }
  if (authz.decision === 'requires_approval') {
    const tr = await trace({ principal: opts.principal, tool: 'predict', input: { account, model: modelId, frontDoor: authz.frontDoor }, output: { held: authz.reason }, decision: 'requires_approval' });
    return { status: 202, body: { ...common, traceId: tr.id } };
  }

  // allow → score. The churn slice keeps its dedicated path (its ISVC serves at
  // the chart-configured endpoint, with the deterministic offline seed fallback).
  if (modelId === CHURN.model) {
    const features: ChurnFeatures = { ...DEFAULT_FEATURES, ...(opts.features ?? {}) } as ChurnFeatures;
    const r = await predictTool(account, features);
    const tr = await trace({
      principal: opts.principal,
      tool: 'predict',
      input: { account, model: modelId, frontDoor: authz.frontDoor, features },
      output: { score: r.score, band: r.band, source: r.source },
      decision: 'allow',
      costUsd: 0.0002,
    });
    return { status: 200, body: { ...common, requestedBy: opts.requestedBy, traceId: tr.id, ...r } };
  }

  // Any other model: it must be DEPLOYED (its own InferenceService) and carry a
  // spec (the feature order the vector is built in).
  const m = getModel(modelId)!; // authorizePredict already 403'd unknown models
  if (m.buildState !== 'deployed' || !m.spec) {
    const reason = !m.spec
      ? 'this model has no spec — define + train it first'
      : `model is not deployed (buildState ${m.buildState ?? 'draft'}) — deploy it to enable predict`;
    const tr = await trace({ principal: opts.principal, tool: 'predict', input: { account, model: modelId, frontDoor: authz.frontDoor }, output: { error: reason }, decision: 'allow' });
    return { status: 409, body: { ...common, error: reason, traceId: tr.id } };
  }
  const features = (opts.features ?? {}) as Record<string, number>;
  const r = await inferOwnService(m, features);
  if (!r.ok) {
    // HONEST failure — a deployed model whose endpoint does not answer is a 502,
    // never a fabricated score.
    const tr = await trace({ principal: opts.principal, tool: 'predict', input: { account, model: modelId, frontDoor: authz.frontDoor, features }, output: { error: r.reason }, decision: 'allow' });
    return { status: 502, body: { ...common, error: r.reason, traceId: tr.id } };
  }
  const isBinary = m.spec.taskType === 'binary_classification';
  const score = isBinary ? Math.min(0.999, Math.max(0.001, r.score)) : r.score;
  const tr = await trace({
    principal: opts.principal,
    tool: 'predict',
    input: { account, model: modelId, frontDoor: authz.frontDoor, features },
    output: { score, source: 'kserve' },
    decision: 'allow',
    costUsd: 0.0002,
  });
  return {
    status: 200,
    body: {
      ...common,
      requestedBy: opts.requestedBy,
      traceId: tr.id,
      account,
      score,
      ...(isBinary ? { band: bandFor(score) } : {}),
      features,
      source: 'kserve',
    },
  };
}
