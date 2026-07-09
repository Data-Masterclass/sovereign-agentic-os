/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { adminCtx, fail } from '../../_ctx';
import { recompile } from '../../_compile';
import { config } from '@/lib/core/config';
import { registerAssistantModel, setAssistantModel, getAssistantModelId } from '@/lib/platform-admin/models';
import { putSecret, secretFingerprint, getSecretServerSide } from '@/lib/infra/secrets';
import { audit } from '@/lib/platform-admin/audit';

export const dynamic = 'force-dynamic';

/**
 * Register the STACKIT managed LLM (or any OpenAI-compatible model) as the ONE
 * assistant model that powers every built-in artifact-building assistant.
 *
 * The raw API key is written ONCE to the secrets manager server-side; the catalog
 * keeps ONLY the reference + a non-reversible fingerprint (secrets-never-raw
 * invariant). We then register the model with the LiteLLM gateway (`/model/new`)
 * — handing the gateway the raw key exactly once so it can proxy the model — and,
 * unless told otherwise, set it as the default assistant. If the gateway is
 * unreachable (offline) we still register it in the catalog and say so.
 */
async function registerWithGateway(alias: string, baseUrl: string, modelName: string, apiKey: string): Promise<boolean> {
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
        // OpenAI-compatible protocol (openai/…) with the STACKIT api_base; the key
        // is presented to the gateway once here and never stored in the catalog.
        litellm_params: { model: `openai/${modelName}`, api_base: baseUrl, api_key: apiKey },
        model_info: { mode: 'chat' },
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
    const label = String(body?.label ?? '').trim();
    const baseUrl = String(body?.baseUrl ?? '').trim();
    const modelName = String(body?.modelName ?? '').trim();
    const apiKey = String(body?.apiKey ?? '');
    const id = String(body?.id ?? '').trim() || 'stackit-managed-assistant';
    const makeDefault = body?.makeDefault !== false;
    if (!label || !baseUrl || !modelName || !apiKey) {
      return NextResponse.json({ error: 'A label, base URL, model name and API key are all required' }, { status: 400 });
    }

    // 1) Raw key → secrets manager (ONCE). Catalog keeps only ref + fingerprint.
    const keyRef = putSecret(`model-${id}`, 'api_key', apiKey);
    const fingerprint = secretFingerprint(keyRef);

    // 2) Register in the catalog (ref, never raw).
    const model = registerAssistantModel({ id, label, endpoint: { baseUrl, modelName, keyRef, fingerprint }, addedBy: user.id });

    // 3) Register with the LiteLLM gateway so it proxies the model (raw key used once).
    const raw = getSecretServerSide(keyRef) ?? apiKey;
    const gatewayOk = await registerWithGateway(model.id, baseUrl, modelName, raw);

    // 4) Make it the default assistant (unless the admin opted out).
    if (makeDefault) setAssistantModel(model.id);

    audit({
      tenant: tenant.id,
      actor: user.id,
      role: user.role,
      action: 'model.assistant-register',
      target: `model:${model.id}`,
      detail: `Registered assistant model ${model.id} (${modelName} @ ${baseUrl}) via secrets manager (${fingerprint}); gateway=${gatewayOk ? 'registered' : 'unreachable'}${makeDefault ? '; set as default assistant' : ''}. Raw key never surfaced.`,
    });

    const { publish } = await recompile();
    return NextResponse.json(
      { model, assistant: getAssistantModelId(), gateway: gatewayOk ? 'registered' : 'unreachable', publish },
      { status: 201 },
    );
  } catch (e) {
    return fail(e);
  }
}
