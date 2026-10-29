/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * GET /api/agents/models — the per-agent model picker's source of truth.
 *
 * FEATURES
 *   • Models read LIVE from the LiteLLM gateway, so a model an admin adds in
 *     LiteLLM's own UI appears in the picker with no redeploy and no second
 *     entry of the same facts in the OS.
 *   • One row per ALIAS (what a caller actually pins), enriched with display
 *     name, provenance, tier and the provider family the admin page groups by.
 *   • `db_model` provenance: true only when EVERY deployment under the alias is
 *     DB-registered, so a mixed alias stays "managed" and is not offered for
 *     removal.
 *   • Degrades to the install catalog when the gateway is unreachable, and SAYS
 *     SO via `source: 'offline'` rather than implying the gateway is empty.
 *
 * USER STORIES
 *   • As a builder, the models I can pin for an agent are the models the
 *     gateway can actually serve right now.
 *   • As a platform admin, I add a model once, in LiteLLM, and the OS follows.
 *   • As a developer working offline, the picker still lists the seeded models
 *     instead of being empty.
 *
 * ARCHITECTURE
 *   Reads through `@core/infra/litellm-admin`, the one LiteLLM read client, so
 *   the Bearer master key, the timeout and the envelope handling live in a
 *   single tested place rather than being restated per route. Display and
 *   provenance come from the agents routing catalog on the alias; the provider
 *   family is inferred from `litellm_params`. Session required (401 for anon):
 *   the model catalog is configuration recon, not a public surface.
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@core/kernel/auth';
import { readModels, type LiteLlmModelRow } from '@core/infra/litellm-admin';
import { MODEL_CATALOG, modelInfo, classifyProviderType, type ModelInfo } from '@tabs/agents/lib/routing';
import { roleModels } from '@core/models/roles';

export const dynamic = 'force-dynamic';

/** A catalog row + the seeded-vs-admin-added discriminator for the admin page. */
type CatalogRow = ModelInfo & { dbModel: boolean };

/**
 * Enrich a live LiteLLM alias with catalog display + provenance + provider TYPE.
 * The Models & Providers page groups the catalog by `providerType`, inferred from
 * the model's `litellm_params` (model prefix + api_base host) so an admin-registered
 * endpoint (STACKIT / OpenAI-compatible / self-hosted) surfaces under its family.
 * Display + provenance still come from the catalog/heuristics on the ALIAS.
 */
function enrich(m: LiteLlmModelRow): ModelInfo | null {
  const name = m.model_name;
  if (typeof name !== 'string' || name.length === 0) return null;
  return { ...modelInfo(name), providerType: classifyProviderType(m.litellm_params) };
}

export async function GET() {
  try {
    await requireUser();
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: (e as { status?: number }).status ?? 401 },
    );
  }

  const fetched = await readModels();
  if (fetched.ok) {
    const seen = new Set<string>();
    const models: ModelInfo[] = [];
    // Admin-added iff EVERY deployment row under the alias is DB-registered —
    // a mixed alias (config seed + a db extra) stays "managed" (not removable).
    const dbModel = new Map<string, boolean>();
    for (const raw of fetched.data) {
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

  // Offline: the install catalog (Standard gpt-oss-20b / Reasoning + Vision Qwen3-VL-235B / Embeddings Qwen3-VL-Embedding-8B).
  // The shipped seed models are all STACKIT-managed inference, so group them there.
  // All install-catalog entries are deployment seeds → dbModel false (not removable).
  const models: CatalogRow[] = Object.values(MODEL_CATALOG).map((m) => ({ ...m, providerType: 'stackit' as const, dbModel: false }));
  return NextResponse.json({ models, source: 'offline', roles: roleModels() });
}
