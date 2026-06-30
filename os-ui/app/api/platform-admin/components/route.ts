/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { adminCtx, fail } from '../_ctx';
import { listComponentsWithStatus, statusOf, toggleComponent, BY_ID } from '@/lib/platform';
import { selfHealFor, versionFor, nodes, pools, OPTIONAL_LAYERS } from '@/lib/platform-admin/components-extra';
import { assertGuarded } from '@/lib/platform-admin/guard';
import { audit } from '@/lib/platform-admin/audit';
import { probeServices, type ServicesStatus } from '@/lib/platform-admin/services';
import { collectAll, correlate } from '@/lib/monitoring';
import { collectSystem } from '@/lib/monitoring/adapters/system-health';
import { deriveScope } from '@/lib/monitoring/scope-core';
import type { Correlation, HealthItem } from '@/lib/monitoring';

export const dynamic = 'force-dynamic';

/**
 * The single infrastructure/platform-internals view. Beyond the component
 * registry + live status, it now also carries what moved out of the user tabs:
 *   • platform services — internal control-plane connectivity (was Connections);
 *   • system & cluster health — the infra signals + self-heal (was Monitoring);
 *   • the dependency/impact chain — how an infra incident propagated to the
 *     pipeline/run/artifact (was Monitoring), built by REUSING the correlation
 *     engine + the same system-health adapter (no duplicated logic).
 * Each optional source degrades to an honest empty state when its backend is off.
 */
export async function GET() {
  try {
    const { user } = await adminCtx();

    let components;
    try {
      const raw = await listComponentsWithStatus();
      components = raw.map((c) => ({ ...c, version: versionFor(c.id), selfHeal: selfHealFor(c.id, c.status) }));
    } catch {
      // Offline / no cluster: degrade to the registry with unknown status.
      components = Object.values(BY_ID).map((c) => ({ ...c, ns: '', lport: c.port, status: 'unknown', version: versionFor(c.id), selfHeal: selfHealFor(c.id, 'unknown') }));
    }

    let services: ServicesStatus = { services: [], up: 0, total: 0 };
    try { services = await probeServices(); } catch { /* degrade to empty */ }

    // System & cluster health + the dependency/impact chain. Admin scope so the
    // full chain (infra incident → pipeline → run → artifact) resolves.
    let systemHealth: HealthItem[] = [];
    let chain: Correlation | null = null;
    try {
      systemHealth = await collectSystem();
      const all = [...await collectAll(), ...systemHealth];
      const scope = deriveScope('admin', user.id, user.domains, 'identity');
      const anchor = systemHealth.find((s) => s.links && Object.keys(s.links).length > 0) ?? systemHealth[0];
      if (anchor) chain = correlate(scope, anchor.id, all);
    } catch { /* offline → empty system health, handled in the UI */ }

    return NextResponse.json({
      components,
      nodes: nodes(),
      pools: pools(),
      optionalLayers: OPTIONAL_LAYERS,
      services: services.services,
      servicesSummary: { up: services.up, total: services.total },
      systemHealth,
      chain,
    });
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
