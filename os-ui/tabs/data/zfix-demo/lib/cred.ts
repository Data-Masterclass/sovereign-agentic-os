/* SPDX-License-Identifier: Apache-2.0
 * FEATURE:    WP-01 demo violation (DO NOT MERGE)
 * USER STORY: As the owner I want to see CI go red with every glue rule named.
 * ARCHITECTURE: one deliberate violation of one GLUE rule.
 */
// Negative twin for GLUE-2: a tab reading the LiteLLM master key.
import { config } from '@core/kernel/config';
export const key = (): string => config.litellmMasterKey;
