/* SPDX-License-Identifier: Apache-2.0
 * FEATURE:    WP-01 demo violation (DO NOT MERGE)
 * USER STORY: As the owner I want to see CI go red with every glue rule named.
 * ARCHITECTURE: one deliberate violation of one GLUE rule.
 */
// Registered (scripts/glue/generators.d/zfix.json) so only the golden's content is in question.
export const generator = 'zfix';
