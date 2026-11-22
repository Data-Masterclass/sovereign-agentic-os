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

import { config } from '@core/kernel/config';
import { getSettings, ensureHydrated as ensureSettingsHydrated, __setForTests as setSettingsForTests } from '@tabs/admin/lib/settings';
import { noteDeprecatedAlias } from '@core/models/role-mapping';
import { roleMappingActive } from '@core/models/role-reconcile';
import { DEFAULT_MASKING, type MaskingPolicy } from '@core/infra/trace-masking';

export type ModelRole = 'reasoning' | 'standard' | 'tools' | 'embeddings' | 'coder';

/**
 * The FOUR roles a platform admin can re-point in the Admin panel. `coder` is deliberately NOT
 * one of them: it is env-only (`LITELLM_CODER_MODEL`) and falls back to the reasoning tier when
 * unset, so the agentic builder gains a tier without adding a noun to the admin UI. See
 * `roleDefault('coder')` below.
 */
export type AdminModelRole = Exclude<ModelRole, 'coder'>;

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
  // CODER — the agentic builder's code-writing tier (stream H). Additive and env-only: an unset
  // `LITELLM_CODER_MODEL` means the role resolves to the REASONING tier, so no deployment needs a
  // new variable for the builder to work, and a code-specialised model is a one-env-var upgrade.
  if (role === 'coder') {
    const pinned = config.litellmCoderModel;
    return pinned && pinned.trim().length > 0 ? pinned : roleDefault('reasoning');
  }
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
  const name = resolveRoleModel(role);
  // Once an admin has mapped the three roles (Platform → Models), the old names are deprecated aliases
  // for them: they keep working at the gateway, and naming one here logs a deprecation (once per name).
  if (roleMappingActive()) noteDeprecatedAlias(name, `the '${role}' model setting`);
  return name;
}

function resolveRoleModel(role: ModelRole): string {
  // `coder` has no admin override (it is not an admin-editable role — see AdminModelRole).
  if (role === 'coder') return roleDefault('coder');
  const override = getSettings().modelRoles[role];
  if (override && override.trim().length > 0) return override;
  // TOOLS FOLLOWS STANDARD. The admin UI offers Standard / Reasoning / Embeddings and says
  // Standard covers "agent execution"; agent nodes run on `tools`. Without this an admin who
  // points Standard at a newly registered provider sees chat move and every agent node stay on
  // the shipped alias. An operator who pinned LITELLM_TOOLS_MODEL / LITELLM_EXEC_MODEL keeps it.
  if (role === 'tools' && !toolsPinnedByEnv()) return resolveRoleModel('standard');
  return roleDefault(role);
}

/** True when the deployment pinned the tools tier itself (env), so it does not follow Standard. */
function toolsPinnedByEnv(): boolean {
  const set = (k: string) => (process.env[k] ?? '').trim().length > 0;
  return set('LITELLM_TOOLS_MODEL') || set('LITELLM_EXEC_MODEL') || set('LITELLM_CHAT_MODEL');
}

/**
 * Make the admin's role choices current before resolving a model for a call. The roles live in
 * the settings store, which is hydrated from its mirror on demand: a fresh os-ui pod (before any
 * admin page loaded) and the run worker (which never writes settings) would otherwise resolve
 * every role to the deployment default and silently ignore what the admin saved.
 */
export async function ensureModelRolesFresh(): Promise<void> {
  // The store is fail-soft itself: an unreadable doc keeps the held values (it never throws).
  await ensureSettingsHydrated();
}

/**
 * Whether STANDARD-FIRST ESCALATION is active (Cost routing). ON (default) means the
 * strictly-validated cost-routed surfaces try the standard tier first and escalate to
 * reasoning only on validation failure; OFF pins them to reasoning directly. This is
 * the ONE admin switch `completeWithEscalation` consults. Nil-safe: an unset/legacy
 * settings blob (older store) defaults ON. Server-only (reads the admin settings).
 */
export function standardFirstEscalationEnabled(): boolean {
  return getSettings().standardFirstEscalation !== false;
}

/**
 * Whether uploaded files get an AUTOMATIC DESCRIPTION + TAGS (one call on the standard model per
 * file, billed to the uploader). ON by default; the ONE admin switch the Files generator
 * consults. The settings are hydrated first: after a pod restart the in-memory value is the
 * default until the saved one is read, and a switch an admin turned OFF must not read ON.
 * Nil-safe: a settings blob saved before the switch existed means ON.
 */
export async function filesAutoDescribeEnabled(): Promise<boolean> {
  await ensureSettingsHydrated();
  return getSettings().filesAutoDescribe !== false;
}

/**
 * The platform admin's Langfuse masking switch (`langfuseMasking`), settings hydrated first. Kept
 * here, with the other platform flags the kernel reads, so `core/infra/masking-policy.ts` (and
 * through it the Langfuse writer and the gateway callers) never imports a tab. Default OFF.
 */
export async function langfuseMaskingPolicy(): Promise<MaskingPolicy> {
  await ensureSettingsHydrated();
  return getSettings().langfuseMasking ?? DEFAULT_MASKING;
}

/** The same value as already held in memory (the synchronous call sites). */
export function heldLangfuseMaskingPolicy(): MaskingPolicy {
  return getSettings().langfuseMasking ?? DEFAULT_MASKING;
}

/** Test seam: set the switch in memory, without the mirror (see settings `__setForTests`). */
export function __setLangfuseMaskingForTests(policy: Partial<MaskingPolicy>): void {
  setSettingsForTests({ langfuseMasking: policy } as never);
}

/** All effective role models — surfaced to the agent builder + admin panel. */
export function roleModels(): Record<ModelRole, string> {
  return {
    reasoning: roleModel('reasoning'),
    standard: roleModel('standard'),
    tools: roleModel('tools'),
    embeddings: roleModel('embeddings'),
    coder: roleModel('coder'),
  };
}
