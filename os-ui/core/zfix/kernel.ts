/* SPDX-License-Identifier: Apache-2.0
 * FEATURE:    WP-01 demo violation (DO NOT MERGE)
 * USER STORY: As the owner I want to see CI go red with every glue rule named.
 * ARCHITECTURE: one deliberate violation of one GLUE rule.
 */
// Negative twin for GLUE-9: the kernel importing a tab.
import { thing } from '@tabs/data/zfix-demo/lib/thing';
export const kernelThing = thing;
