/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { adminCtx, fail } from '../../_ctx';
import { recompile } from '../../_compile';
import { setAssistantModel, clearAssistantModel, clearAssistantIf } from '@tabs/admin/lib/models';
import { readGatewayCatalog } from '@core/models/gateway-catalog';
import { removeGatewayModel } from '@tabs/admin/lib/model-remove';
import { modelReferences } from '@tabs/admin/lib/model-references';
import { ensureHydrated as ensureAgentsHydrated } from '@tabs/agents/lib/store';
import { audit } from '@tabs/admin/lib/audit';

export const dynamic = 'force-dynamic';

/**
 * PATCH — what the OS decides about a model: the assistant pin. Enabling, disabling and capping a
 * model are LiteLLM's (model access, budgets): the OS no longer keeps a second switch, so those two
 * ops answer 410 instead of being accepted and ignored. The pin is checked against LiteLLM right now:
 * the alias must exist and be a chat model; a gateway that cannot be read refuses (nothing changes).
 */
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
      case 'cap':
        return NextResponse.json(
          { error: `The OS no longer enables, disables or caps models: that is done in LiteLLM (model access and budgets). ${id} was not changed.` },
          { status: 410 },
        );
      case 'assistant': {
        const read = await readGatewayCatalog();
        if (!read.ok) return NextResponse.json({ error: `LiteLLM could not be read (${read.error}), so the assistant model was not changed.` }, { status: 502 });
        const model = read.data.models.find((m) => m.name === id);
        if (!model) return NextResponse.json({ error: `LiteLLM has no model ${id}` }, { status: 404 });
        if (model.mode !== 'chat') return NextResponse.json({ error: `Model ${id} is not a chat model — the assistant must be chat-capable` }, { status: 400 });
        result = { assistant: setAssistantModel(id) };
        detail = `Set the assistant model (the ONE LLM powering every built-in assistant) to ${id}`;
        break;
      }
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
 *   3. Config-model guard — the gateway is asked (`/model/info` db_model) whether
 *      EVERY deployment row is DB-registered; a model set by the deployment's config
 *      file (`model_list`) is refused as managed-by-the-deployment, so a missing
 *      Remove button is never the only defense. The OS keeps no model record to
 *      update: LiteLLM is the only place the model exists.
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

    // A3: the helper binds the one admin read/write clients itself — no key in a route.
    const gateway = await removeGatewayModel(id);
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

    if (gateway.status === 'not-found') {
      return NextResponse.json({ error: 'Unknown model' }, { status: 404 });
    }
    // The model is gone from LiteLLM, the only place it existed. An explicit assistant pin at it
    // goes back to "follow Standard" so it can never point at a ghost.
    clearAssistantIf(id);

    audit({
      tenant: tenant.id, actor: user.id, role: user.role, action: 'model.remove', target: `model:${id}`,
      detail: `Removed administrator-added model ${id} (gateway deleted ${gateway.ids.length} deployment(s); ${references.length} reference(s)${force && references.length > 0 ? ', force-confirmed' : ''})`,
    });
    const { publish } = await recompile();
    return NextResponse.json({ removed: id, gateway: gateway.status, references, publish });
  } catch (e) {
    return fail(e);
  }
}
