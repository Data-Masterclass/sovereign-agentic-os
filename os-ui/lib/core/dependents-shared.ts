/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * The CLIENT-SAFE half of the dependency spine (0.6.98): the Dependent shape + the pure
 * summary formatter the shared ConfirmDialog renders. Kept import-free (no server-only /
 * Next) so the client dialog AND the server walk (lib/core/dependents.ts, which re-exports
 * these) share ONE source of truth. The actual walk lives server-side; this is just the
 * shape it returns over the wire and how we phrase it.
 */

/** A tab a dependent lives on — drives where the warn links / how it's grouped. */
export type DependentTab = 'metrics' | 'dashboards' | 'software' | 'agents';

/** One artifact that depends on the queried one. `kind` is the human noun; `tab` its home. */
export type Dependent = { kind: string; id: string; name: string; tab: DependentTab };

/**
 * A one-line, direction-aware summary of the dependents for the confirm dialog. `break`
 * (demote/archive/delete) is a warning — "used by … — this will break their access";
 * `promote` is informational — "… will re-point to the promoted copy once it materializes".
 */
export function dependentsSummary(deps: Dependent[], direction: 'promote' | 'break'): string {
  if (deps.length === 0) {
    return direction === 'promote'
      ? 'No dependents yet.'
      : 'Nothing depends on this — safe to continue.';
  }
  const counts = new Map<DependentTab, number>();
  for (const d of deps) counts.set(d.tab, (counts.get(d.tab) ?? 0) + 1);
  const label: Record<DependentTab, [string, string]> = {
    metrics: ['metric', 'metrics'],
    dashboards: ['dashboard', 'dashboards'],
    software: ['app', 'apps'],
    agents: ['agent', 'agents'],
  };
  const parts: string[] = [];
  for (const tab of ['metrics', 'dashboards', 'software', 'agents'] as DependentTab[]) {
    const n = counts.get(tab);
    if (!n) continue;
    parts.push(`${n} ${n === 1 ? label[tab][0] : label[tab][1]}`);
  }
  const list = parts.join(', ');
  return direction === 'promote'
    ? `${list} will re-point to the promoted copy once it materializes.`
    : `Used by ${list} — this will break their access.`;
}
