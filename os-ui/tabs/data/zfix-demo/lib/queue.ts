/* SPDX-License-Identifier: Apache-2.0
 * FEATURE:    WP-01 demo violation (DO NOT MERGE)
 * USER STORY: As the owner I want to see CI go red with every glue rule named.
 * ARCHITECTURE: one deliberate violation of one GLUE rule.
 */
// Negative twin for GLUE-5: a hand-rolled job queue next to pg-boss.
export const CLAIM_NEXT = 'SELECT id FROM zfix_jobs ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED';
