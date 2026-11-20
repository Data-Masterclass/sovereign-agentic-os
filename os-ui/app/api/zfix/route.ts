/* SPDX-License-Identifier: Apache-2.0
 * FEATURE:    WP-01 demo violation (DO NOT MERGE)
 * USER STORY: As the owner I want to see CI go red with every glue rule named.
 * ARCHITECTURE: one deliberate violation of one GLUE rule.
 */
// Negative twin for GLUE-7: a mutating route with no governance authorize() before the effect.
export async function POST(): Promise<Response> {
  return new Response('written', { status: 200 });
}
