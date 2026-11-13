/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { adminCtx, fail } from '../_ctx';
import { listComponentsWithStatus, statusOf, toggleComponent, BY_ID } from '@tabs/admin/lib/platform';
import { selfHealFor, versionFor, nodes, pools, OPTIONAL_LAYERS, trinoAccessRulesRow, gitMirrorRow } from '@tabs/admin/lib/components-extra';
import { config } from '@core/kernel/config';
import { lastReconcileOutcome, DEFAULT_RECONCILE_PERIOD_MS } from '@core/infra/trino-rules-server';
import { assertGuarded } from '@tabs/admin/lib/guard';
import { audit } from '@tabs/admin/lib/audit';
import { probeServices, type ServicesStatus } from '@tabs/admin/lib/services';
import { collectAll, correlate } from '@tabs/monitoring/lib/index';
import { collectSystem } from '@tabs/monitoring/lib/adapters/system-health';
import { deriveScope } from '@tabs/monitoring/lib/scope-core';
import type { Correlation, HealthItem } from '@tabs/monitoring/lib/index';

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

    // Trino access rules (engine rebuild B3; B3-review-H-4). The reconciler is fail-soft, so its
    // last outcome has to be VISIBLE — a silent failure leaves the chart's permissive bootstrap in
    // force. The row is pure (`trinoAccessRulesRow`) and absent when the feature is off.
    const periodMs = config.trinoAccessRules
      ? Math.max(1, config.trinoAccessRulesIntervalMinutes) * 60_000
      : DEFAULT_RECONCILE_PERIOD_MS;
    const rulesRow = trinoAccessRulesRow({
      enabled: config.trinoAccessRules,
      outcome: lastReconcileOutcome(),
      now: Date.now(),
      periodMs,
    });
    if (rulesRow) {
      systemHealth = [
        ...systemHealth,
        {
          id: `sys-${rulesRow.id}`,
          lens: 'system',
          title: rulesRow.name,
          health: rulesRow.health,
          detail: rulesRow.detail,
          owner: 'platform',
          domain: 'platform',
          cluster: true,
          ts: rulesRow.at ? new Date(rulesRow.at).toISOString() : undefined,
          selfHeal:
            rulesRow.health === 'green'
              ? 'Healthy — reconciled at boot, on every directory write, and on the periodic repair pass.'
              : 'Needs a human: check the os-ui Role grants get+patch on the trino-access-rules ConfigMap.',
          links: { systemId: `sys-${rulesRow.id}` },
          source: 'live',
        },
      ];
    }

    // Git mirror (engine rebuild Part D, checklist X2). The push after a commit is
    // fire-and-forget, so its last outcome has to be VISIBLE — otherwise the remote silently
    // falls behind. Pure row (`gitMirrorRow`); absent when git is off or no mirror is configured.
    try {
      const { ensureMirrorsHydrated, mirrorSignals } = await import('@core/infra/git-mirror');
      await ensureMirrorsHydrated();
      const mirrorRow = gitMirrorRow({ enabled: config.dataProjectGit, signals: mirrorSignals(), now: Date.now() });
      if (mirrorRow) {
        systemHealth = [
          ...systemHealth,
          {
            id: `sys-${mirrorRow.id}`,
            lens: 'system',
            title: mirrorRow.name,
            health: mirrorRow.health,
            detail: mirrorRow.detail,
            owner: 'platform',
            domain: 'platform',
            cluster: true,
            ts: mirrorRow.at ? new Date(mirrorRow.at).toISOString() : undefined,
            selfHeal:
              mirrorRow.health === 'green'
                ? 'Healthy — every changed commit is pushed, and a failure is retried by the next commit.'
                : 'Needs a human: check the mirror URL, the token Secret and the egress allowlist on Platform → Data projects.',
            links: { systemId: `sys-${mirrorRow.id}` },
            source: 'live',
          },
        ];
      }
    } catch {
      /* the mirror store is best-effort: no row rather than a failed components read */
    }

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
