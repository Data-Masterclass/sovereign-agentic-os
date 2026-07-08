/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
/**
 * Model-role resolver — the ONE runtime resolution point for the three default
 * model roles the OS uses everywhere:
 *
 *   • reasoning  → planning / deep reasoning (default `config.litellmReasoningModel`)
 *   • standard   → assistant / agent execution, light work (default `config.litellmExecModel`)
 *   • embeddings → the shared embedding model (default `config.embedModel`)
 *
 * Resolution order (per role): the persisted PLATFORM-ADMIN setting
 * (`settings.modelRoles.<role>`) when it is a non-empty LiteLLM `model_name`,
 * ELSE the env-configurable `config.ts` default. So env defaults keep working
 * out of the box (local/offline) and an admin re-points a role live without a
 * rebuild. This never rewrites the fixed LiteLLM aliases — it only chooses WHICH
 * live alias each app role uses.
 *
 * Server-only (reads the in-process admin settings store).
 */

import { config } from '../config.ts';
import { getSettings } from '../platform-admin/settings.ts';

export type ModelRole = 'reasoning' | 'standard' | 'embeddings';

/** The env default for a role (the resolution fallback when no admin override). */
export function roleDefault(role: ModelRole): string {
  switch (role) {
    case 'reasoning':
      return config.litellmReasoningModel;
    case 'standard':
      return config.litellmExecModel;
    case 'embeddings':
      return config.embedModel;
  }
}

/** Effective LiteLLM model_name for a role: admin override if set, else env default. */
export function roleModel(role: ModelRole): string {
  const override = getSettings().modelRoles[role];
  return override && override.trim().length > 0 ? override : roleDefault(role);
}

/** All three effective role models — surfaced to the agent builder + admin panel. */
export function roleModels(): Record<ModelRole, string> {
  return { reasoning: roleModel('reasoning'), standard: roleModel('standard'), embeddings: roleModel('embeddings') };
}
