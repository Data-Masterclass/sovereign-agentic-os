/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { adminCtx, fail } from '../_ctx';
import { recompile } from '../_compile';
import { adminPost } from '@core/infra/litellm-write';
import { registerModel } from '@tabs/admin/lib/models';
import { classifyProviderType, PROVIDER_TYPE_LABELS, type ProviderType } from '@tabs/agents/lib/routing';
import { buildProviderModel, normaliseProvider, type ProviderModelPayload } from '@tabs/admin/lib/provider-registration';
import { ensureHydrated as ensurePricesHydrated, setModelPrices } from '@tabs/admin/lib/model-prices';
import { putSecret, secretFingerprint, getSecretServerSide } from '@core/infra/secrets';
import { audit } from '@tabs/admin/lib/audit';

export const dynamic = 'force-dynamic';

/**
 * "Add provider" wizard — the self-service front end to LiteLLM. An admin connects
 * their OWN LLM backend behind the governed gateway: pick a provider type, give the
 * minimal fields, and the OS (1) writes the raw API key ONCE to the secrets manager,
 * (2) registers the model with LiteLLM `/model/new` (now durable — store_model_in_db),
 * and (3) records it in the governed catalog holding ONLY a secret REFERENCE +
 * fingerprint. The raw key is NEVER echoed, logged, returned, or stored in the catalog.
 *
 * MVP provider types (this phase): `openai-compatible` (generic self-hosted OpenAI
 * API) and `stackit` (STACKIT managed inference). Azure/Bedrock + a test-connection
 * step are LATER phases — the type union + wizard already have slots for them, but
 * this route rejects them with an honest "not yet supported" so nothing half-works.
 */
const SUPPORTED: ProviderType[] = ['openai-compatible', 'stackit'];

async function registerWithGateway(payload: ProviderModelPayload): Promise<boolean> {
  // The ONE admin write door (`litellm-write.ts`): master key stays inside it; a failure is a result.
  const res = await adminPost('/model/new', payload, 4000);
  return res.ok;
}

const num = (v: unknown): number | null => (v === undefined || v === null || v === '' ? null : Number(v));

export async function POST(req: Request) {
  try {
    const { user, tenant } = await adminCtx();
    const body = await req.json();
    const providerType = String(body?.providerType ?? '').trim() as ProviderType;
    const alias = String(body?.alias ?? '').trim();
    const baseUrl = String(body?.baseUrl ?? '').trim();
    const modelName = String(body?.modelName ?? '').trim();
    const apiKey = String(body?.apiKey ?? '');
    const label = String(body?.label ?? '').trim();
    const litellmProvider = String(body?.litellmProvider ?? '').trim();
    const inputPerM = num(body?.inputPerM);
    const outputPerM = num(body?.outputPerM);
    const task = (['chat', 'reasoning', 'embedding'].includes(String(body?.task)) ? String(body?.task) : 'chat') as 'chat' | 'reasoning' | 'embedding';

    if (!SUPPORTED.includes(providerType)) {
      return NextResponse.json(
        { error: `Provider type "${providerType}" is not supported yet. This phase ships: ${SUPPORTED.map((t) => PROVIDER_TYPE_LABELS[t]).join(', ')}.` },
        { status: 400 },
      );
    }
    const mode = task === 'embedding' ? 'embedding' : 'chat';
    // Validate the whole LiteLLM body BEFORE the key touches the secrets store (400 on a gap).
    // The real key goes in after the vault write; this probe carries a placeholder.
    const native = normaliseProvider(litellmProvider);
    const probe = buildProviderModel({ alias, modelName, baseUrl, apiKey: apiKey ? '-' : '', mode, litellmProvider: native, inputPerM, outputPerM });
    const model = probe.litellm_params.model;

    // 1) Raw key → secrets manager (ONCE). Catalog keeps only ref + fingerprint.
    const keyRef = putSecret(`model-${alias}`, 'api_key', apiKey);
    const fingerprint = secretFingerprint(keyRef);

    // 2) Register in the governed catalog under its provider family (ref, never raw).
    //    Classify from the SAME signal LiteLLM sees (model prefix + api_base host) so
    //    the stored group matches what /model/info would report.
    const classified = classifyProviderType({ model, api_base: baseUrl });
    const catalogModel = registerModel({
      id: alias,
      label: label || `${modelName} (${native ? `LiteLLM ${native}` : PROVIDER_TYPE_LABELS[providerType]})`,
      task,
      providerType: classified,
      endpoint: { baseUrl, modelName, keyRef, fingerprint },
      addedBy: user.id,
    });

    // 3) Register with the LiteLLM gateway so it proxies the model (raw key used ONCE,
    //    then dropped). store_model_in_db makes this durable across pod restarts.
    const raw = getSecretServerSide(keyRef) ?? apiKey;
    const gatewayOk = await registerWithGateway({ ...probe, litellm_params: { ...probe.litellm_params, api_key: raw } });

    // 4) The same prices in the OS price book, so Monitoring shows the cost LiteLLM books.
    if (inputPerM !== null && outputPerM !== null) {
      await ensurePricesHydrated();
      setModelPrices({ [alias]: { inputPerM, outputPerM } }, user.id);
    }

    audit({
      tenant: tenant.id,
      actor: user.id,
      role: user.role,
      action: 'model.provider-register',
      target: `model:${alias}`,
      // fingerprint-only — the raw key never appears in the audit trail.
      detail: `Registered ${providerType} model ${alias} (${model} @ ${baseUrl || 'provider default endpoint'}, task=${task}, access group ${probe.model_info.access_groups.join(',')}${probe.litellm_params.input_cost_per_token !== undefined ? ', priced' : ', unpriced'}) via secrets manager (${fingerprint}); gateway=${gatewayOk ? 'registered' : 'unreachable'}. Raw key never surfaced.`,
    });

    const { publish } = await recompile();
    return NextResponse.json(
      { model: catalogModel, providerType: classified, gateway: gatewayOk ? 'registered' : 'unreachable', fingerprint, publish },
      { status: 201 },
    );
  } catch (e) {
    return fail(e);
  }
}
