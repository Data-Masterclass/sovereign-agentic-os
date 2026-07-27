/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { adminCtx, fail } from '../../_ctx';
import { recompile } from '../../_compile';
import { setEnabled, setCap, setAssistantModel, clearAssistantModel, listModels, removeModel } from '@/lib/platform-admin/models';
import { removeGatewayModel } from '@/lib/platform-admin/model-remove';
import { modelReferences } from '@/lib/platform-admin/model-references';
import { ensureHydrated as ensureAgentsHydrated } from '@/lib/agents/store';
import { config } from '@/lib/core/config';
import { audit } from '@/lib/platform-admin/audit';

export const dynamic = 'force-dynamic';

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { user, tenant } = await adminCtx();
    const { id } = await ctx.params;
    const body = await req.json();
    const op = String(body?.op ?? '');
    let detail = '';
    let result: unknown;
    switch (op) {
      case 'enable':
        result = setEnabled(id, Boolean(body?.enabled));
        detail = `${body?.enabled ? 'Enabled' : 'Disabled'} model ${id}`;
        break;
      case 'cap':
        result = setCap(id, body?.capEUR === null ? null : Number(body?.capEUR));
        detail = `Set per-model cap on ${id} to ${body?.capEUR === null ? 'none' : `€${body?.capEUR}`}`;
        break;
      case 'assistant':
        result = setAssistantModel(id);
        detail = `Set the assistant model (the ONE LLM powering every built-in assistant) to ${id}`;
        break;
      case 'assistant-clear':
        clearAssistantModel();
        result = { cleared: true };
        detail = 'Cleared the assistant override — the assistant follows the Standard role default';
        break;
      default:
        return NextResponse.json({ error: 'Unknown op' }, { status: 400 });
    }
    audit({ tenant: tenant.id, actor: user.id, role: user.role, action: `model.${op}`, target: `model:${id}`, detail });
    const { publish } = await recompile();
    return NextResponse.json({ result, publish });
  } catch (e) {
    return fail(e);
  }
}

/**
 * Remove an ADMINISTRATOR-ADDED model. Three server-side guards, in order:
 *   1. adminCtx — Platform Admin only (401/403 for everyone else).
 *   2. Reference sweep — role pins, the assistant pin and agent per-node pins
 *      (lib/platform-admin/model-references). A referenced model is refused with
 *      409 + the usages unless the caller passed `?force=1` (the UI's explicit
 *      second confirmation). Never silently break.
 *   3. Seeded-model guard — the gateway is asked (`/model/info` db_model) whether
 *      EVERY deployment row is DB-registered; a config-seeded alias is refused as
 *      managed-by-the-deployment. `removeModel` re-enforces the same rule on the
 *      governed catalog (no `endpoint` ⇒ seed ⇒ 409), so a missing Remove button
 *      is never the only defense.
 * The master key stays server-side inside removeGatewayModel — never returned.
 */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { user, tenant } = await adminCtx();
    const { id } = await ctx.params;
    const force = new URL(req.url).searchParams.get('force') === '1';

    // Hydrate the agent-system store (best-effort) so the sweep sees mirrored systems.
    await ensureAgentsHydrated().catch(() => {});
    const references = modelReferences(id);
    if (references.length > 0 && !force) {
      return NextResponse.json(
        { error: `${id} is in use — confirm again to remove it anyway`, references },
        { status: 409 },
      );
    }

    const gateway = await removeGatewayModel(id, { url: config.litellmUrl, masterKey: config.litellmMasterKey });
    if (gateway.status === 'managed') {
      return NextResponse.json(
        { error: `${id} is managed by the deployment (seeded in the gateway config) — it cannot be removed here` },
        { status: 409 },
      );
    }
    if (gateway.status === 'unreachable') {
      return NextResponse.json(
        { error: 'The LiteLLM gateway is unreachable — cannot verify the model is administrator-added, so nothing was removed. Try again when the gateway is back.' },
        { status: 502 },
      );
    }
    if (gateway.status === 'failed') {
      return NextResponse.json({ error: 'The gateway rejected the delete — the model was not removed' }, { status: 502 });
    }

    // Gateway says removed (or never registered there). Maintain the governance record.
    const inCatalog = listModels().some((m) => m.id === id);
    if (gateway.status === 'not-found' && !inCatalog) {
      return NextResponse.json({ error: 'Unknown model' }, { status: 404 });
    }
    if (inCatalog) removeModel(id); // seed guard (no endpoint ⇒ 409) enforced inside

    audit({
      tenant: tenant.id, actor: user.id, role: user.role, action: 'model.remove', target: `model:${id}`,
      detail: `Removed administrator-added model ${id} (gateway ${gateway.status === 'removed' ? `deleted ${gateway.ids.length} deployment(s)` : 'had no row'}; ${references.length} reference(s)${force && references.length > 0 ? ', force-confirmed' : ''})`,
    });
    const { publish } = await recompile();
    return NextResponse.json({ removed: id, gateway: gateway.status, references, publish });
  } catch (e) {
    return fail(e);
  }
}
