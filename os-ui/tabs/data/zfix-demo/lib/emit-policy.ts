/* SPDX-License-Identifier: Apache-2.0
 * FEATURE:    WP-01 demo violation (DO NOT MERGE)
 * USER STORY: As the owner I want to see CI go red with every glue rule named.
 * ARCHITECTURE: one deliberate violation of one GLUE rule.
 */
// Negative twin for GLUE-6: a native-config generator with no golden fixture run through `opa check`.
export function generatePolicy(domain: string): Record<string, string> {
  return { 'policy/zfix.rego': `package zfix.${domain}\n` };
}
