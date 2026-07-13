/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
/**
 * Model-role resolver — the ONE runtime resolution point for the model roles the
 * OS uses everywhere. There are exactly FOUR presented models: the three live
 * STACKIT-managed sovereign models, plus the mock (offline/testing) fallback:
 *
 *   • reasoning  → STACKIT reasoning model  (`sovereign-reasoning` → Qwen3-VL-235B)
 *   • standard   → STACKIT standard/worker  (`sovereign-default`   → gpt-oss-20b)
 *   • tools      → the multi-agent graph's EXEC/"fast" tier. Defaults to the
 *                  STANDARD model (gpt-oss-20b) so fast gatherer nodes run cheap;
 *                  the Auto router escalates write/decide/synthesis nodes to the
 *                  reasoning model. gpt-oss-20b's "harmony" tool-call framing is
 *                  stripped defensively; pin this role to reasoning to override.
 *   • embeddings → STACKIT embeddings model (`sovereign-embed` → Qwen3-VL-Embedding-8B)
 *
 *   • mock (`sovereign-mock`) → NOT a role. It is the OFFLINE / testing default:
 *                  when NO live gateway is configured (no admin override AND no env
 *                  override for the role) every role resolves to the mock so the
 *                  teaching flow runs on a laptop. It is only ever "connected" when
 *                  an admin explicitly picks it for a role.
 *
 * Resolution order (per role):
 *   1. the persisted PLATFORM-ADMIN override (`settings.modelRoles.<role>`) when it
 *      is a non-empty LiteLLM `model_name`;
 *   2. ELSE the deployment CONNECTED default — the role's STACKIT alias, sourced
 *      from the env-configurable `config.ts` (helm/operator can re-point it, but the
 *      baseline the whole OS ships with is the live STACKIT alias);
 *   3. ELSE (no live gateway wired at all) the MOCK model (`sovereign-mock`) — the
 *      honest offline default, so the teaching flow runs on a laptop.
 *
 * "Connected" means a live gateway model is configured for the role (via config/env
 * or an admin override). When NOTHING is configured — `config` resolves the role to
 * the mock chat model — we return the mock explicitly. This keeps the set ADMIN-
 * CONFIGURABLE (an admin re-points a role, or a deployment sets the env, without a
 * rebuild) while making mock the default when nothing is wired. It never rewrites
 * the fixed LiteLLM aliases — it only chooses WHICH live alias each app role uses.
 *
 * Server-only (reads the in-process admin settings store).
 */

import { config } from '../core/config.ts';
import { getSettings } from '../platform-admin/settings.ts';

export type ModelRole = 'reasoning' | 'standard' | 'tools' | 'embeddings';

/** The offline/testing fallback alias — the ONLY non-role model we present. */
export const MOCK_MODEL = 'sovereign-mock';

/**
 * The default for a role when there is no admin override: the env-configurable
 * connected STACKIT alias from `config.ts`, ELSE the mock model. `config` already
 * falls the chat-fronted roles back to `sovereign-mock` when no gateway model is
 * set; embeddings/tools do not, so we coalesce here to the mock so EVERY role is
 * mock-by-default when nothing is wired. A deployment/env that pins a real alias
 * (the STACKIT default, or an operator override) keeps that alias — "connected".
 */
export function roleDefault(role: ModelRole): string {
  const configured = (() => {
    switch (role) {
      case 'reasoning':
        return config.litellmReasoningModel;
      case 'standard':
        return config.litellmExecModel;
      case 'tools':
        return config.litellmToolsModel;
      case 'embeddings':
        return config.embedModel;
    }
  })();
  return configured && configured.trim().length > 0 ? configured : MOCK_MODEL;
}

/** Effective LiteLLM model_name for a role: admin override if set, else env default. */
export function roleModel(role: ModelRole): string {
  const override = getSettings().modelRoles[role];
  return override && override.trim().length > 0 ? override : roleDefault(role);
}

/** All effective role models — surfaced to the agent builder + admin panel. */
export function roleModels(): Record<ModelRole, string> {
  return {
    reasoning: roleModel('reasoning'),
    standard: roleModel('standard'),
    tools: roleModel('tools'),
    embeddings: roleModel('embeddings'),
  };
}
