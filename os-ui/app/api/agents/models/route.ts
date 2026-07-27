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
  /** `db_model` — LiteLLM's own seeded-vs-admin-added flag: true = registered at
   *  runtime via /model/new (DB-backed, removable), false/absent = seeded from the
   *  static model_list config (managed by the deployment). */
  model_info?: { mode?: string; db_model?: boolean };
};

/** A catalog row + the seeded-vs-admin-added discriminator for the admin page. */
type CatalogRow = ModelInfo & { dbModel: boolean };

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
      // Admin-added iff EVERY deployment row under the alias is DB-registered —
      // a mixed alias (config seed + a db extra) stays "managed" (not removable).
      const dbModel = new Map<string, boolean>();
      for (const raw of data?.data ?? []) {
        const info = enrich(raw);
        if (!info) continue;
        dbModel.set(info.model_name, (dbModel.get(info.model_name) ?? true) && raw.model_info?.db_model === true);
        if (!seen.has(info.model_name)) {
          seen.add(info.model_name);
          models.push(info);
        }
      }
      if (models.length > 0) {
        const rows: CatalogRow[] = models.map((m) => ({ ...m, dbModel: dbModel.get(m.model_name) === true }));
        return NextResponse.json({ models: rows, source: 'litellm', roles: roleModels() });
      }
    }
  } catch {
    /* fall through to the offline catalog */
  } finally {
    clearTimeout(timer);
  }
  // Offline: the install catalog (Standard gpt-oss-20b / Reasoning + Vision Qwen3-VL-235B / Embeddings Qwen3-VL-Embedding-8B).
  // The shipped seed models are all STACKIT-managed inference, so group them there.
  // All install-catalog entries are deployment seeds → dbModel false (not removable).
  const models: CatalogRow[] = Object.values(MODEL_CATALOG).map((m) => ({ ...m, providerType: 'stackit' as const, dbModel: false }));
  return NextResponse.json({ models, source: 'offline', roles: roleModels() });
}
