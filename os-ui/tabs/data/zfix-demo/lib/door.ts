/* SPDX-License-Identifier: Apache-2.0
 * FEATURE:    WP-01 demo violation (DO NOT MERGE)
 * USER STORY: As the owner I want to see CI go red with every glue rule named.
 * ARCHITECTURE: one deliberate violation of one GLUE rule.
 */
// Negative twin for GLUE-1: a tab talking to a component directly instead of through core/adapters.
export async function trinoInfo(): Promise<unknown> {
  const res = await fetch('http://trino:8080/v1/info');
  return res.json();
}
