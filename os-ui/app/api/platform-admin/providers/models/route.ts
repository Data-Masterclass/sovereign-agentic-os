/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * GET  /api/platform-admin/providers/models?preset=&provider= — step 3: models LiteLLM knows for the
 *      provider (its own price map); empty + freeText for operator-named models (Azure deployments,
 *      Ollama tags, an OpenAI-compatible server's ids).
 * POST /api/platform-admin/providers/models — step 5: LiteLLM `/model/new` by connection name, into the
 *      access group the shared agent key holds, then the governed catalog row (caps, on/off) so the
 *      model is eligible for roles. The model itself lives in LiteLLM's database (durable).
 */
import { NextResponse } from 'next/server';
import { adminCtx, fail } from '../../_ctx';
import { authorize } from '@core/infra/governed';
import { recompile } from '../../_compile';
import { modelSuggestions, registerProviderModel } from '@tabs/admin/lib/llm-providers';
import { registerModel } from '@tabs/admin/lib/models';
import { classifyProviderType } from '@tabs/agents/lib/routing';
import { audit } from '@tabs/admin/lib/audit';
import { ensureHydrated as ensurePricesHydrated, setModelPrices } from '@tabs/admin/lib/model-prices';

const num = (v: unknown): number | null => (v === undefined || v === null || v === '' ? null : Number(v));

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    await adminCtx();
    const u = new URL(req.url);
    const r = await modelSuggestions(u.searchParams.get('preset') ?? '', u.searchParams.get('provider') ?? undefined);
    if (!r.ok) return NextResponse.json({ error: r.message, code: r.code, models: [], freeText: true }, { status: r.status });
    return NextResponse.json({ models: r.models, freeText: r.freeText });
  } catch (e) {
    return fail(e);
  }
}

export async function POST(req: Request) {
  try {
    const { user, tenant } = await adminCtx();
    const authz = await authorize(`user:${user.id}`, 'admin');
    if (!authz.allowed) return NextResponse.json({ error: `Policy did not allow this admin action (${authz.policy}).`, code: 'policy_denied' }, { status: 403 });
    let b: Record<string, unknown>;
    try { b = (await req.json()) as Record<string, unknown>; } catch { return NextResponse.json({ error: 'The request body must be JSON' }, { status: 400 }); }
    const s = (k: string) => (typeof b[k] === 'string' ? (b[k] as string) : undefined);
    const task = s('task') === 'embedding' || s('mode') === 'embedding' ? 'embedding' : s('task') === 'reasoning' ? 'reasoning' : 'chat';
    const r = await registerProviderModel({
      preset: s('preset') ?? '', provider: s('provider'), connection: s('connection') ?? '', model: s('model') ?? '',
      alias: s('alias') ?? '', mode: task === 'embedding' ? 'embedding' : 'chat',
      inputPerM: num(b.inputPerM), outputPerM: num(b.outputPerM),
    });
    if (!r.ok) return NextResponse.json({ error: r.message, code: r.code }, { status: r.status });
    const model = registerModel({
      id: r.alias, label: `${s('model') ?? r.alias}`, task,
      providerType: classifyProviderType({ model: r.model }),
      endpoint: { credentialName: s('connection') ?? '', litellmModel: r.model },
      addedBy: user.id,
    });
    // The same prices in the OS price book, so Monitoring shows the cost LiteLLM books.
    const inputPerM = num(b.inputPerM), outputPerM = num(b.outputPerM);
    if (inputPerM !== null && outputPerM !== null) {
      await ensurePricesHydrated();
      setModelPrices({ [r.alias]: { inputPerM, outputPerM } }, user.id);
    }
    audit({
      tenant: tenant.id, actor: user.id, role: user.role, action: 'llm.model-register', target: `model:${r.alias}`,
      detail: `Registered ${r.alias} → ${r.model} on connection ${s('connection')} in LiteLLM (access group joined).`,
    });
    const { publish } = await recompile();
    return NextResponse.json({ model, litellmModel: r.model, publish }, { status: 201 });
  } catch (e) {
    return fail(e);
  }
}
