/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { config } from '@/lib/config';
import { requireUser } from '@/lib/auth';
import { MODEL_CATALOG, modelInfo, type ModelInfo } from '@/lib/agents/routing';

export const dynamic = 'force-dynamic';

/** One /model/info row we care about (the alias the caller pins). */
type LiteLLMModel = {
  model_name?: string;
  litellm_params?: { model?: string };
  model_info?: { mode?: string };
};

/**
 * Enrich a live LiteLLM alias with catalog display + provenance. NB: this stack
 * fronts EVERY sovereign model through the OpenAI-compatible protocol, so the
 * `litellm_params.model` prefix is always `openai/…` (protocol, NOT provider) with
 * a STACKIT api_base — it is a misleading provenance signal here. We therefore
 * classify by the ALIAS (catalog first, then the `sovereign-*` name heuristic in
 * modelInfo), which is correct for this deployment: all `sovereign-*` = internal.
 */
function enrich(m: LiteLLMModel): ModelInfo | null {
  const name = m.model_name;
  if (typeof name !== 'string' || name.length === 0) return null;
  return modelInfo(name);
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
      if (models.length > 0) return NextResponse.json({ models, source: 'litellm' });
    }
  } catch {
    /* fall through to the offline catalog */
  } finally {
    clearTimeout(timer);
  }
  // Offline: the install catalog (Ministral light / Magistral reasoning / Qwen vision).
  const models: ModelInfo[] = Object.values(MODEL_CATALOG);
  return NextResponse.json({ models, source: 'offline' });
}
