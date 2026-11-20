/* SPDX-License-Identifier: Apache-2.0
 * FEATURE:    WP-01 demo violation (DO NOT MERGE)
 * USER STORY: As the owner I want to see CI go red with every glue rule named.
 * ARCHITECTURE: one deliberate violation of one GLUE rule.
 */
// Negative twin for GLUE-1: `new pg.Pool(` — a database client opened outside core/adapters.
import pg from 'pg';
export const pool = new pg.Pool({ max: 1 });
