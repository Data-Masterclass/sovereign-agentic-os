/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { adminCtx, fail } from '../../_ctx';
import { recompile } from '../../_compile';
import { renameDomain, transferDomain, setArchived, setLayer, type DomainLayers } from '@/lib/platform-admin/domains';
import { audit } from '@/lib/platform-admin/audit';

export const dynamic = 'force-dynamic';

/** PATCH supports rename / transfer / archive / layer-toggle via an `op` field. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { user, tenant } = await adminCtx();
    const { id } = await ctx.params;
    const body = await req.json();
    const op = String(body?.op ?? '');
    let detail = '';
    let domain;
    switch (op) {
      case 'rename':
        domain = renameDomain(id, String(body?.name ?? ''));
        detail = `Renamed domain to "${domain.name}"`;
        break;
      case 'transfer':
        domain = transferDomain(id, String(body?.owner ?? ''));
        detail = `Transferred domain to owner ${domain.owner}`;
        break;
      case 'archive':
        domain = setArchived(id, Boolean(body?.archived));
        detail = `${domain.archived ? 'Archived' : 'Unarchived'} domain`;
        break;
      case 'layer':
        domain = setLayer(id, String(body?.layer) as keyof DomainLayers, Boolean(body?.enabled));
        detail = `Set ${String(body?.layer)}.enabled=${Boolean(body?.enabled)}`;
        break;
      default:
        return NextResponse.json({ error: 'Unknown op' }, { status: 400 });
    }
    audit({ tenant: tenant.id, actor: user.id, role: user.role, action: `domain.${op}`, target: `domain:${id}`, detail });
    const { publish } = await recompile();
    return NextResponse.json({ domain, publish });
  } catch (e) {
    return fail(e);
  }
}
