/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
/**
 * Model roles — the OS's own names for what it asks a model to do, mapped onto the THREE role names it
 * is allowed to call: `sovereign-strong`, `sovereign-worker`, `sovereign-embedding`.
 *
 *   • standard   → worker     assistants, light work, summaries
 *   • tools      → worker     the agent engine's fast/execution tier
 *   • reasoning  → strong     planning, deep reasoning, image understanding
 *   • coder      → strong     the app builder's code-writing tier
 *   • embeddings → embedding  Knowledge and Files vectors
 *
 * Which CATALOG model a role means is NOT decided here. The mapping is the OS's file `os/models.yml`
 * (Platform → Models), enforced at the gateway as LiteLLM's `router_settings.model_group_alias`
 * (`role-reconcile.ts`), so a remap changes the next call with no restart and no key rebuild.
 * Nothing in the OS resolves a role to a model: the old admin override (`settings.modelRoles`) and
 * the `LITELLM_*_MODEL` / `*_EMBED_MODEL` env defaults are gone (`role-seed.ts` carries an old
 * override into the file once).
 *
 * Server-only (reads the in-process admin settings store for the two switches below).
 */
import { getSettings, ensureHydrated as ensureSettingsHydrated, maskingSwitchKnown, _reset as resetSettings, __setForTests as setSettingsForTests } from '@tabs/admin/lib/settings';
import { noteDeprecatedAlias, ROLE_EMBEDDING, ROLE_STRONG, ROLE_WORKER, type RoleName } from '@core/models/role-mapping';
import { DEFAULT_MASKING, UNKNOWN_MASKING, type MaskingPolicy } from '@core/infra/trace-masking';

export type ModelRole = 'reasoning' | 'standard' | 'tools' | 'embeddings' | 'coder';

const ROLE_OF: Record<ModelRole, RoleName> = {
  standard: ROLE_WORKER,
  tools: ROLE_WORKER,
  reasoning: ROLE_STRONG,
  coder: ROLE_STRONG,
  embeddings: ROLE_EMBEDDING,
};

/** The role name the OS sends to the gateway for one of its own roles. */
export function roleModel(role: ModelRole): RoleName {
  return ROLE_OF[role];
}

/** Make the admin's switches current before a call (the settings are hydrated from their mirror on demand). */
export async function ensureModelRolesFresh(): Promise<void> {
  // The store is fail-soft itself: an unreadable doc keeps the held values (it never throws).
  await ensureSettingsHydrated();
}

/** A stored name (an agent pinned to an old alias, a per-agent pin) that is deprecated: log it once. */
export function noteStoredModelName(name: string, where: string): void {
  noteDeprecatedAlias(name, where);
}

/**
 * The OS-WIDE LEAD-MODEL SWITCH (Platform → Models, "Save costs"; settings `standardFirstEscalation`).
 * ON = cost-saving mode: the WORKER leads and strong is the escalation path. OFF or UNSET (the default):
 * the STRONG role leads. Only a real `true` turns it on, so an unset or legacy blob means strong leads.
 * Server-only (reads the admin settings).
 */
export function standardFirstEscalationEnabled(): boolean {
  return getSettings().standardFirstEscalation === true;
}

export type LeadMode = 'strong' | 'worker';
export function leadMode(): LeadMode {
  return standardFirstEscalationEnabled() ? 'worker' : 'strong';
}

/** The role that leads (plans, chooses tools, answers) and the one the other side of the switch escalates to or delegates to. */
export function leadModel(): { mode: LeadMode; lead: RoleName; escalation: RoleName } {
  return leadMode() === 'worker'
    ? { mode: 'worker', lead: ROLE_WORKER, escalation: ROLE_STRONG }
    : { mode: 'strong', lead: ROLE_STRONG, escalation: ROLE_WORKER };
}

/**
 * Whether uploaded files get an AUTOMATIC DESCRIPTION + TAGS (one call on the worker role per
 * file, billed to the uploader). ON by default. The settings are hydrated first: after a pod
 * restart the in-memory value is the default until the saved one is read, and a switch an admin
 * turned OFF must not read ON.
 */
export async function filesAutoDescribeEnabled(): Promise<boolean> {
  await ensureSettingsHydrated();
  return getSettings().filesAutoDescribe !== false;
}

/**
 * The platform admin's Langfuse masking switch (`langfuseMasking`), settings hydrated first. Kept
 * here, with the other platform flags the kernel reads, so `core/infra/masking-policy.ts` (and
 * through it the Langfuse writer and the gateway callers) never imports a tab. Default OFF.
 *
 * FAILS SAFE: until the switch has been read from the settings store (a pod that just restarted,
 * a store that cannot be reached) it is UNKNOWN, and an unknown privacy switch is the strictest
 * level (`UNKNOWN_MASKING`: all content masked), never the default OFF. Logged on every failed read
 * (`settings.ts`, at most every few seconds) and visible through `langfuseMaskingStatus()`. Once the store answers the unknown state ends.
 */
export async function langfuseMaskingPolicy(): Promise<MaskingPolicy> {
  await ensureSettingsHydrated();
  return heldLangfuseMaskingPolicy();
}

/** The same value as already held in memory (the synchronous call sites): strict while unknown. */
export function heldLangfuseMaskingPolicy(): MaskingPolicy {
  if (!maskingSwitchKnown()) return { ...UNKNOWN_MASKING };
  return getSettings().langfuseMasking ?? DEFAULT_MASKING;
}

/** Whether the switch was read, and what applies right now (for logs, Monitoring and tests). */
export function langfuseMaskingStatus(): { known: boolean; effective: MaskingPolicy } {
  const known = maskingSwitchKnown();
  return { known, effective: known ? (getSettings().langfuseMasking ?? DEFAULT_MASKING) : { ...UNKNOWN_MASKING } };
}

/** Test seam: set the switch in memory, without the mirror (see settings `__setForTests`). */
export function __setLangfuseMaskingForTests(policy: Partial<MaskingPolicy>): void {
  setSettingsForTests({ langfuseMasking: policy } as never);
}

/** Test seam: set the lead-model switch in memory (ON = the worker leads), without the mirror. */
export function __setStandardFirstForTests(on: boolean): void {
  setSettingsForTests({ standardFirstEscalation: on } as never);
}

/** Test seam: a fresh process (nothing read, nothing set): the masking switch is unknown again. */
export function __resetLangfuseMaskingForTests(): void {
  resetSettings();
}

/** All role names the OS sends — surfaced to the agent builder + admin panel. */
export function roleModels(): Record<ModelRole, RoleName> {
  return { ...ROLE_OF };
}
