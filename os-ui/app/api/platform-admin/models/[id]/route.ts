/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { adminCtx, fail } from '../../_ctx';
import { recompile } from '../../_compile';
import { setEnabled, setCap, setDefault, type ModelTask } from '@/lib/platform-admin/models';
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
      case 'default':
        result = setDefault(String(body?.task) as ModelTask, id);
        detail = `Set default ${String(body?.task)} model to ${id}`;
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
