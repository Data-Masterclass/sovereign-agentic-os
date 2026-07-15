/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { adminCtx, fail } from '../_ctx';
import { recompile } from '../_compile';
import { config } from '@/lib/core/config';
import { registerModel } from '@/lib/platform-admin/models';
import { classifyProviderType, litellmModelString, PROVIDER_TYPE_LABELS, type ProviderType } from '@/lib/agents/routing';
import { putSecret, secretFingerprint, getSecretServerSide } from '@/lib/infra/secrets';
import { audit } from '@/lib/platform-admin/audit';

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

async function registerWithGateway(alias: string, model: string, baseUrl: string, apiKey: string, mode: string): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(`${config.litellmUrl}/model/new`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.litellmMasterKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        model_name: alias,
        litellm_params: { model, api_base: baseUrl, api_key: apiKey },
        model_info: { mode },
      }),
      cache: 'no-store',
      signal: ctrl.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function POST(req: Request) {
  try {
    const { user, tenant } = await adminCtx();
    const body = await req.json();
    const providerType = String(body?.providerType ?? '').trim() as ProviderType;
    const alias = String(body?.alias ?? '').trim();
    const baseUrl = String(body?.baseUrl ?? '').trim();
    const modelName = String(body?.modelName ?? '').trim();
    const apiKey = String(body?.apiKey ?? '');
    const task = (['chat', 'reasoning', 'embedding'].includes(String(body?.task)) ? String(body?.task) : 'chat') as 'chat' | 'reasoning' | 'embedding';

    if (!SUPPORTED.includes(providerType)) {
      return NextResponse.json(
        { error: `Provider type "${providerType}" is not supported yet. This phase ships: ${SUPPORTED.map((t) => PROVIDER_TYPE_LABELS[t]).join(', ')}.` },
        { status: 400 },
      );
    }
    if (!alias || !baseUrl || !modelName || !apiKey) {
      return NextResponse.json({ error: 'An alias, base URL, model id and API key are all required' }, { status: 400 });
    }

    const model = litellmModelString(modelName);
    const mode = task === 'embedding' ? 'embedding' : 'chat';

    // 1) Raw key → secrets manager (ONCE). Catalog keeps only ref + fingerprint.
    const keyRef = putSecret(`model-${alias}`, 'api_key', apiKey);
    const fingerprint = secretFingerprint(keyRef);

    // 2) Register in the governed catalog under its provider family (ref, never raw).
    //    Classify from the SAME signal LiteLLM sees (model prefix + api_base host) so
    //    the stored group matches what /model/info would report.
    const classified = classifyProviderType({ model, api_base: baseUrl });
    const catalogModel = registerModel({
      id: alias,
      label: `${modelName} (${PROVIDER_TYPE_LABELS[providerType]})`,
      task,
      providerType: classified,
      endpoint: { baseUrl, modelName, keyRef, fingerprint },
      addedBy: user.id,
    });

    // 3) Register with the LiteLLM gateway so it proxies the model (raw key used ONCE,
    //    then dropped). store_model_in_db makes this durable across pod restarts.
    const raw = getSecretServerSide(keyRef) ?? apiKey;
    const gatewayOk = await registerWithGateway(alias, model, baseUrl, raw, mode);

    audit({
      tenant: tenant.id,
      actor: user.id,
      role: user.role,
      action: 'model.provider-register',
      target: `model:${alias}`,
      // fingerprint-only — the raw key never appears in the audit trail.
      detail: `Registered ${providerType} model ${alias} (${model} @ ${baseUrl}, task=${task}) via secrets manager (${fingerprint}); gateway=${gatewayOk ? 'registered' : 'unreachable'}. Raw key never surfaced.`,
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
