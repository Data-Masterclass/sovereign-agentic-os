/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { adminCtx, fail } from '../_ctx';
import { listComponentsWithStatus, statusOf, toggleComponent, BY_ID } from '@/lib/platform';
import { selfHealFor, versionFor, nodes, pools, OPTIONAL_LAYERS } from '@/lib/platform-admin/components-extra';
import { assertGuarded } from '@/lib/platform-admin/guard';
import { audit } from '@/lib/platform-admin/audit';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await adminCtx();
    let components;
    try {
      const raw = await listComponentsWithStatus();
      components = raw.map((c) => ({ ...c, version: versionFor(c.id), selfHeal: selfHealFor(c.id, c.status) }));
    } catch {
      // Offline / no cluster: degrade to the registry with unknown status.
      components = Object.values(BY_ID).map((c) => ({ ...c, ns: '', lport: c.port, status: 'unknown', version: versionFor(c.id), selfHeal: selfHealFor(c.id, 'unknown') }));
    }
    return NextResponse.json({ components, nodes: nodes(), pools: pools(), optionalLayers: OPTIONAL_LAYERS });
  } catch (e) {
    return fail(e);
  }
}

/**
 * Toggle an already-provisioned component on/off. Turning a component OFF is a
 * destructive toggle → it is GUARDED (typed confirmation) + audited. This never
 * provisions infrastructure; it only scales a governed workload 0<->1.
 */
export async function POST(req: Request) {
  try {
    const { user, tenant } = await adminCtx();
    const body = await req.json();
    const id = String(body?.id ?? '');
    const c = BY_ID[id];
    if (!c) return NextResponse.json({ error: 'Unknown component' }, { status: 404 });

    // Determine direction so we can guard a disable.
    let current = 'unknown';
    try { current = await statusOf(c); } catch { /* offline */ }
    const turningOff = current === 'running' || current === 'starting';
    if (turningOff) assertGuarded('disable', id, body?.confirm); // 412 unless confirmed

    const result = await toggleComponent(id);
    audit({
      tenant: tenant.id, actor: user.id, role: user.role,
      action: turningOff ? 'component.disable' : 'component.enable',
      target: `component:${id}`,
      detail: `${turningOff ? 'Disabled' : 'Enabled'} ${c.name} — ${result.msg}`,
      result: result.ok ? 'ok' : 'error',
      guarded: turningOff,
    });
    return NextResponse.json({ result });
  } catch (e) {
    return fail(e);
  }
}
