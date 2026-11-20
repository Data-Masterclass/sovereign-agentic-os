/* SPDX-License-Identifier: Apache-2.0
 * FEATURE:    WP-01 demo violation (DO NOT MERGE)
 * USER STORY: As the owner I want to see CI go red with every glue rule named.
 * ARCHITECTURE: one deliberate violation of one GLUE rule.
 */
// Negative twin for GLUE-3: a failure turned into a success-shaped value.
export function datasets(raw: string): unknown[] {
  try {
    return JSON.parse(raw) as unknown[];
  } catch {
    return [];
  }
}
