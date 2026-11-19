/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The page-header cluster pill — its wording, from the real stack status
 * USER STORY: As a user I want the header to say "Live cluster" only when the platform services
 *             really answer, and otherwise how many are up or that the status is unknown.
 * ARCHITECTURE:
 *   - Pure. `ClusterPill.tsx` reads `/api/status` (the same `probeServices` roll-up the Stack
 *     status strip uses) and renders whatever this function says.
 */

/**
 * What the page-header cluster pill says, from the stack status the app already reads
 * (`/api/status` → `probeServices`, the same source as the Stack status strip). It says
 * "Live cluster" ONLY when every probed service answered; otherwise it states how many are up,
 * or that the status is not known. Pure, so the wording is tested.
 */
export type ClusterStatus = { up: number; total: number };
export type ClusterPillState = { label: string; tone: 'up' | 'down' | 'unknown'; title: string };

export function clusterPillState(status: ClusterStatus | null, failed = false): ClusterPillState {
  if (failed) return { label: 'Cluster status unknown', tone: 'unknown', title: 'The stack status could not be read.' };
  if (!status) return { label: 'Checking cluster…', tone: 'unknown', title: 'Reading the stack status.' };
  if (!Number.isFinite(status.total) || status.total <= 0) {
    return { label: 'Cluster status unknown', tone: 'unknown', title: 'No platform service is probed.' };
  }
  if (status.up >= status.total) {
    return { label: 'Live cluster', tone: 'up', title: `All ${status.total} platform services answered.` };
  }
  return {
    label: `${status.up}/${status.total} services up`,
    tone: 'down',
    title: `${status.total - status.up} of ${status.total} platform services did not answer. See Settings → Stack status.`,
  };
}
