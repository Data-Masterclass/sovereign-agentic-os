/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { config } from '@/lib/core/config';
import { requireUser } from '@/lib/core/auth';
import { MODEL_CATALOG, modelInfo, classifyProviderType, type ModelInfo } from '@/lib/agents/routing';
import { roleModels } from '@/lib/models/roles';

export const dynamic = 'force-dynamic';

/** One /model/info row we care about (the alias the caller pins). */
type LiteLLMModel = {
  model_name?: string;
  litellm_params?: { model?: string; api_base?: string };
  model_info?: { mode?: string };
};

/**
 * Enrich a live LiteLLM alias with catalog display + provenance + provider TYPE.
 * The Models & Providers page groups the catalog by `providerType`, inferred from
 * the model's `litellm_params` (model prefix + api_base host) so an admin-registered
 * endpoint (STACKIT / OpenAI-compatible / self-hosted) surfaces under its family.
 * Display + provenance still come from the catalog/heuristics on the ALIAS.
 */
function enrich(m: LiteLLMModel): ModelInfo | null {
  const name = m.model_name;
  if (typeof name !== 'string' || name.length === 0) return null;
  return { ...modelInfo(name), providerType: classifyProviderType(m.litellm_params) };
}

/**
 * The per-agent model picker source — populated LIVE from the LiteLLM gateway's
 * /model/info (Bearer master key, server-side only; no endpoint or key reaches the
 * browser). Each entry carries `{ model_name, display, provenance, tier }` so the
 * UI can show the real model name + an in-box/hosted badge. When LiteLLM is
 * unreachable (kind/offline) we degrade to the install catalog and SAY SO.
 */
export async function GET() {
  try {
    await requireUser();
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: (e as { status?: number }).status ?? 401 },
    );
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  try {
    const res = await fetch(`${config.litellmUrl}/model/info`, {
      headers: { authorization: `Bearer ${config.litellmMasterKey}`, accept: 'application/json' },
      cache: 'no-store',
      signal: ctrl.signal,
    });
    if (res.ok) {
      const data = (await res.json()) as { data?: LiteLLMModel[] };
      const seen = new Set<string>();
      const models: ModelInfo[] = [];
      for (const raw of data?.data ?? []) {
        const info = enrich(raw);
        if (info && !seen.has(info.model_name)) {
          seen.add(info.model_name);
          models.push(info);
        }
      }
      if (models.length > 0) return NextResponse.json({ models, source: 'litellm', roles: roleModels() });
    }
  } catch {
    /* fall through to the offline catalog */
  } finally {
    clearTimeout(timer);
  }
  // Offline: the install catalog (Standard gpt-oss-20b / Reasoning + Vision Qwen3-VL-235B / Embeddings Qwen3-VL-Embedding-8B).
  // The shipped seed models are all STACKIT-managed inference, so group them there.
  const models: ModelInfo[] = Object.values(MODEL_CATALOG).map((m) => ({ ...m, providerType: 'stackit' as const }));
  return NextResponse.json({ models, source: 'offline', roles: roleModels() });
}
