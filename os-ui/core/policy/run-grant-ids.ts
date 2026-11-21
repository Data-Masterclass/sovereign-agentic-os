/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The ids and hashes a Dagster run grant is matched by (WP-15)
 * USER STORY: As a data owner I want my schedule's standing grant to have one id that the
 *             generated repo, the OS and Dagster all agree on, without the repo holding any secret.
 * ARCHITECTURE: Pure (no I/O), so the dbt project generator can use it. An id is not a credential:
 *             the grant row in `os_governance.run_grants` and the run-start check decide.
 */
import { createHash } from 'node:crypto';

/** The stable id of a schedule's standing grant. `schedule` is the schedule entry's model name. */
export function standingGrantId(domain: string, dataset: string, principal: string, schedule: string): string {
  const h = createHash('sha256').update(JSON.stringify([domain, dataset, principal, schedule])).digest('hex');
  return `rg_std_${h.slice(0, 24)}`;
}

/** Order-independent hash of an asset selection (`[['sales','gold_x']]` or `['sales/gold_x']`). */
export function selectionHash(keys: (string[] | string)[]): string {
  const flat = [...new Set(keys.map((k) => (Array.isArray(k) ? k.join('/') : k)))].sort();
  return createHash('sha256').update(JSON.stringify(flat)).digest('hex');
}
