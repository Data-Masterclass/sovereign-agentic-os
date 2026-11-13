/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       engineering view
 * FEATURE:    Loading the five tab adapters into the registry, without the kernel importing a tab
 * USER STORY: As a maintainer I want the engineering view's adapters to arrive the same way the
 *             MCP's tab bundles do — a dynamic import per enabled tab — so `check-structure`'s
 *             CORE-INDEPENDENCE rule stays satisfied and a disabled tab costs nothing.
 * ARCHITECTURE:
 *   - The exact pattern of `core/mcp/register-experimental.ts`: a table of specs, `import()` at
 *     call time (so no static `@tabs/*` edge from `core/`), gated on `TAB_FEATURES`, loaded in
 *     parallel and registered in declared order. A tab whose module fails to load is SKIPPED with
 *     its reason recorded — `get_engineering_view` then answers honestly that the kind has no
 *     adapter here, which is the behaviour checklist T7 asks for.
 *   - Memoized: one promise per process. Callers (`core/mcp/engineering-tools.ts`, the panel's API
 *     route) await `engineeringAdaptersReady` before reading the registry.
 */
import 'server-only';
import { TAB_FEATURES } from '@core/kernel/tabs';
import { registerEngineeringAdapter } from '@core/engineering/registry';
import type { EngineeringAdapter, EngineeringKind } from '@core/engineering/types';

type AdapterSpec = {
  kind: EngineeringKind;
  /** The TAB_FEATURES key that must be on for this kind to have a view. */
  feature: string;
  load: () => Promise<EngineeringAdapter>;
};

/** One spec per kind. The import specifier is a literal so Next can code-split it. */
const SPECS: AdapterSpec[] = [
  { kind: 'dataset', feature: 'data', load: async () => (await import('@tabs/data/lib/engineering')).datasetEngineeringView },
  { kind: 'metric', feature: 'metrics', load: async () => (await import('@tabs/metrics/lib/engineering')).metricEngineeringView },
  { kind: 'dashboard', feature: 'dashboards', load: async () => (await import('@tabs/dashboards/lib/engineering')).dashboardEngineeringView },
  { kind: 'agent_system', feature: 'agents', load: async () => (await import('@tabs/agents/lib/engineering')).agentSystemEngineeringView },
  { kind: 'app', feature: 'software', load: async () => (await import('@tabs/software/lib/engineering')).appEngineeringView },
];

/** Why a kind has no adapter in this process — reported, never swallowed. */
const skipped = new Map<EngineeringKind, string>();

/** The reason a kind is absent from the registry, or null when it is present / unknown. */
export function engineeringKindSkipReason(kind: EngineeringKind): string | null {
  return skipped.get(kind) ?? null;
}

/** Load every enabled tab's adapter, then register in declared order. Parameterised for tests. */
export async function registerEngineeringAdapters(
  isEnabled: (feature: string) => boolean = (f) => TAB_FEATURES.has(f),
  specs: AdapterSpec[] = SPECS,
): Promise<void> {
  const wanted: AdapterSpec[] = [];
  for (const spec of specs) {
    if (isEnabled(spec.feature)) wanted.push(spec);
    else skipped.set(spec.kind, `the '${spec.feature}' tab is not enabled in this deployment (OS_ENABLED_TABS)`);
  }
  const loaded = await Promise.all(
    wanted.map((s) =>
      s.load().then(
        (a) => ({ spec: s, adapter: a as EngineeringAdapter | undefined }),
        (e: unknown) => ({ spec: s, adapter: undefined, error: (e as Error).message }),
      ),
    ),
  );
  for (const entry of loaded) {
    const adapter = entry.adapter;
    if (typeof adapter !== 'function') {
      const why = 'error' in entry && entry.error ? `its module failed to load (${entry.error})` : 'its module exports no adapter';
      skipped.set(entry.spec.kind, `the '${entry.spec.feature}' tab did not provide an engineering view: ${why}`);
      continue;
    }
    registerEngineeringAdapter(entry.spec.kind, adapter);
  }
}

/** Memoized — the registry is filled exactly once per process. */
export const engineeringAdaptersReady: Promise<void> = registerEngineeringAdapters();
