/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { adminCtx, fail } from '../_ctx';
import { recompile } from '../_compile';
import { listAllowlist, addAllowlist, removeAllowlist, listRequests, decideRequest, posture } from '@/lib/platform-admin/security';
import { listProviderKeys } from '@/lib/platform-admin/models';
import { audit } from '@/lib/platform-admin/audit';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const { tenant } = await adminCtx();
    const { compiled } = await recompile();
    const view = posture({
      residency: tenant.residency,
      secretsStored: listProviderKeys().length,
      opaBundleVersion: compiled.bundle.version,
      opaLastCompiled: compiled.bundle.generatedAt,
      auditRetentionDays: 365,
    });
    return NextResponse.json({ posture: view, allowlist: listAllowlist(), requests: listRequests() });
  } catch (e) {
    return fail(e);
  }
}

export async function POST(req: Request) {
  try {
    const { user, tenant } = await adminCtx();
    const body = await req.json();
    const op = String(body?.op ?? '');
    let detail = '';
    let payload: unknown;
    switch (op) {
      case 'allow-add': {
        const host = addAllowlist(String(body?.host ?? ''));
        detail = `Added ${host} to the egress allowlist`;
        payload = { host };
        break;
      }
      case 'allow-remove': {
        const host = removeAllowlist(String(body?.host ?? ''));
        detail = `Removed ${host} from the egress allowlist`;
        payload = { host };
        break;
      }
      case 'request-decide': {
        const { request, host } = decideRequest(String(body?.id ?? ''), body?.decision === 'approved' ? 'approved' : 'rejected');
        detail = `${request.status === 'approved' ? 'Approved' : 'Rejected'} egress request for ${request.host}${host ? ' → allowlisted' : ''}`;
        payload = { request };
        break;
      }
      default:
        return NextResponse.json({ error: 'Unknown op' }, { status: 400 });
    }
    audit({ tenant: tenant.id, actor: user.id, role: user.role, action: `egress.${op}`, target: 'egress', detail });
    const { publish } = await recompile();
    return NextResponse.json({ ok: true, payload, publish });
  } catch (e) {
    return fail(e);
  }
}
