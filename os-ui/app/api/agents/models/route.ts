/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * GET /api/agents/models — the model picker's source of truth, and Platform → Models & Providers' list.
 *
 * FEATURES
 *   • The list IS LiteLLM's: read live from `/model/info` on every call (and the connections from
 *     `/credentials`). A model added or removed in LiteLLM — its UI, its API, the OS "Add a provider"
 *     flow — appears or disappears here with no change in the OS. The OS keeps no list, no seed
 *     catalog and no enable switch of its own.
 *   • One row per ALIAS (what a caller actually pins), enriched with display name, provenance and
 *     tier (labels only) and the provider family the admin page groups by.
 *   • `management` says who owns the model: `config` (the deployment's `model_list`, changed by a
 *     deploy), `database` (registered in LiteLLM, removable there) or `mixed` (an alias served by
 *     both; treated as config). See `core/models/gateway-catalog.ts`.
 *   • `credentials`: the LiteLLM connections (names and non-secret info only) and the models using each.
 *   • A gateway that cannot be read is `source: 'unavailable'` with the reason and NO models. There is
 *     no offline list: an old list would offer models that may not exist.
 *   • `images` on every row: whether that alias may be sent an image — the answer of
 *     `canReceiveImages` (the explicit, admin-controlled allowlist in `@core/models/capabilities`),
 *     never the `tier` guess. `imageInput` carries the effective list and any problem with the override.
 *
 * USER STORIES
 *   • As a builder, the models I can pin for an agent are the models the gateway can serve right now.
 *   • As a platform admin, I add a model once, in LiteLLM, and the OS follows.
 *   • As a platform admin, when LiteLLM is down I am told it is unreachable, not shown a stale list.
 *
 * ARCHITECTURE
 *   Reads through `@core/models/gateway-catalog` over `@core/infra/litellm-admin`, the one LiteLLM read
 *   client (Bearer master key, timeout, envelope handling in one tested place). Display and provenance
 *   come from the agents routing catalog on the alias (labels only); the provider family is inferred
 *   from `litellm_params`. Session required (401 for anon): the model catalog is configuration recon.
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@core/kernel/auth';
import { readGatewayCatalog, type GatewayModel } from '@core/models/gateway-catalog';
import { modelInfo, classifyProviderType, type ModelInfo } from '@tabs/agents/lib/routing';
import { roleModels } from '@core/models/roles';
import { canReceiveImages, imageAllowlist } from '@core/models/capabilities';

export const dynamic = 'force-dynamic';

/** One LiteLLM alias + display labels + who manages it + the image flag for the admin page. */
type CatalogRow = ModelInfo & {
  management: GatewayModel['management'];
  deployments: number;
  mode: GatewayModel['mode'];
  credentials: string[];
  litellmModels: string[];
  images: boolean;
};

/** The effective image allowlist, for display (the decision itself is `canReceiveImages`). */
function imageInput() {
  const { models, source, warnings } = imageAllowlist();
  return { models: [...models], source, warnings };
}

/**
 * Enrich a live LiteLLM alias with display + provenance + provider TYPE. The page groups the
 * catalog by `providerType`, inferred from the model's `litellm_params` (model prefix + api_base
 * host) so an admin-registered endpoint (STACKIT / OpenAI-compatible / self-hosted) surfaces
 * under its family. Display + provenance are labels on the ALIAS, never a source of models.
 */
function enrich(m: GatewayModel): CatalogRow {
  return {
    ...modelInfo(m.name),
    providerType: classifyProviderType(m.primary),
    management: m.management,
    deployments: m.deployments,
    mode: m.mode,
    credentials: m.credentials,
    litellmModels: m.litellmModels,
    images: canReceiveImages(m.name),
  };
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

  const read = await readGatewayCatalog();
  if (!read.ok) {
    // No fallback list: say that LiteLLM could not be read, and why.
    return NextResponse.json({ models: [], credentials: null, source: 'unavailable', error: `LiteLLM could not be read: ${read.error}`, roles: roleModels(), imageInput: imageInput() });
  }
  const models = read.data.models.map(enrich);
  return NextResponse.json({
    models,
    credentials: read.data.credentials,
    ...(read.data.credentialsError ? { credentialsError: read.data.credentialsError } : {}),
    source: 'litellm',
    roles: roleModels(),
    imageInput: imageInput(),
  });
}
