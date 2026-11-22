/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Schedules and sensors paused in Dagster, shown in Monitoring
 * USER STORY: As a platform engineer I pause a schedule in the Dagster UI; Monitoring shows it as
 *             paused in Dagster, the OS leaves it alone, and the owner is told who can resume it.
 * ARCHITECTURE:
 *   - Pure over Dagster's own instigation states (read over GraphQL by `readInstigatorStates`).
 *   - Dagster owns pause state. A STOPPED schedule is reported only when the OS expects it to run
 *     (`expected`: the dataset's sync is enabled), because a disabled sync's schedule starts STOPPED
 *     (repo.py `default_status`). The OS never starts or resumes one.
 *   - The OS's own failure and principals sensors being STOPPED is a warning: they protect the
 *     domain, and only a person in Dagster can start them.
 */
import type { Alert, HealthItem } from '@tabs/monitoring/lib/types';

export type InstigatorState = { kind: 'schedule' | 'sensor'; name: string; status: string };
export type ExpectedSchedule = { domain: string; owner: string; datasetId: string };

/** The sensors repo.py defines for the OS (`os_quarantine`, `os_principals`). */
export const OS_SENSORS = new Set(['os_quarantine', 'os_principals']);

export function dagsterStateItems(states: InstigatorState[], expected: Map<string, ExpectedSchedule>): HealthItem[] {
  const out: HealthItem[] = [];
  for (const s of states) {
    if (s.kind !== 'schedule' || s.status !== 'STOPPED') continue;
    const e = expected.get(s.name);
    if (!e) continue;
    out.push({
      id: `pl-paused-${s.name}`, lens: 'pipelines', health: 'amber', title: `${e.datasetId} — schedule paused in Dagster`,
      detail: `The schedule ${s.name} is paused in Dagster (by a person, or by the OS failure sensor after repeated failures) while the dataset's sync is enabled. Dagster owns this state: resume it in Dagster. The OS does not change it.`,
      owner: e.owner, domain: e.domain, links: { pipelineId: `pl-paused-${s.name}`, datasetId: e.datasetId }, source: 'live',
    } as HealthItem);
  }
  return out;
}

export function dagsterStateAlerts(states: InstigatorState[] | null, readError?: string): Alert[] {
  const base = { owner: 'platform', domain: 'platform', cluster: true, disposition: 'notified' as const, source: 'live' as const };
  if (states === null) {
    return [{ ...base, id: 'al-dagster-state-unreadable', severity: 'warning', title: 'Dagster schedule state unreadable',
      detail: `Dagster's schedules and sensors could not be read (${(readError ?? 'unknown error').slice(0, 200)}), so a paused schedule would not be seen.` }];
  }
  return states.filter((s) => s.kind === 'sensor' && OS_SENSORS.has(s.name) && s.status === 'STOPPED').map((s): Alert => ({
    ...base, id: `al-dagster-sensor-${s.name}`, severity: 'warning', title: `Dagster sensor ${s.name} is stopped`,
    detail: `${s.name} is one of the OS's own sensors and is STOPPED in Dagster. The OS does not restart it: start it in the Dagster UI.`,
  }));
}
