/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    The ONE model an agent runs on: `model: strong | standard | auto` in system.yaml
 * USER STORY: As a builder I choose per agent whether it runs on the strong model or the standard
 *             (cheaper) model, or let the OS decide once, at Build, with a one-line reason I can see
 *             and override. Every run then uses exactly that model for that agent.
 * ARCHITECTURE:
 *   - The definition (per agent, all optional):
 *         model: strong | standard | auto
 *         model_resolved: strong | standard   # only with `auto`; written by Build
 *         model_reason: "<one line>"          # only with `auto`; why Build chose it
 *     `auto` is decided ONCE per Build by the strong model (`build/model-choice.ts`), persisted here,
 *     and re-decided by the next Build — so runs are reproducible.
 *   - No field (every system made before the field existed) = `strong`, exactly the behaviour since
 *     agent runs lost the hand-off. `auto` not yet resolved = `strong` too.
 *   - `strong` is the gateway role `sovereign-strong`, `standard` is `sovereign-worker`.
 *   - Old values in stored files (a role name, a deprecated alias, any other pin) are read as the
 *     tier they stand for: the OS only ever calls role names, so a pin to anything else means strong.
 *   - Pure and client-safe (the builder UI reads the same rules).
 */
import { DEPRECATED_ALIASES, ROLE_STRONG, ROLE_WORKER } from '@core/models/role-names';

export type AgentModelTier = 'strong' | 'standard';
export type AgentModelChoice = AgentModelTier | 'auto';
export const AGENT_MODEL_CHOICES: readonly AgentModelChoice[] = ['strong', 'standard', 'auto'];

/** The longest reason kept in the definition. */
export const MODEL_REASON_MAX = 200;

/** The part of an agent definition the model rules read. */
export type AgentModelFields = { model?: AgentModelChoice; model_resolved?: AgentModelTier; model_reason?: string; model_basis?: string };

/**
 * A stored `model` value → the choice it means, or undefined for "not set". Accepts the three choices
 * and the older spellings (role names, deprecated aliases, `worker`/`reasoning`, any other pin).
 */
export function normalizeModelChoice(raw: unknown): AgentModelChoice | undefined {
  if (raw === undefined || raw === null) return undefined;
  const v = String(raw).trim().toLowerCase();
  if (v === '') return undefined;
  if (v === 'strong' || v === 'standard' || v === 'auto') return v;
  if (v === 'worker' || v === 'light' || v === 'execution' || v === ROLE_WORKER) return 'standard';
  const role = Object.hasOwn(DEPRECATED_ALIASES, v) ? DEPRECATED_ALIASES[v] : undefined;
  if (role === ROLE_WORKER) return 'standard';
  return 'strong';
}

/** A stored `model_resolved` → the tier, or undefined when it is not one. */
export function normalizeModelTier(raw: unknown): AgentModelTier | undefined {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return v === 'strong' || v === 'standard' ? v : undefined;
}

/** The tier an agent runs on: its choice, the Build's resolution of `auto`, else strong. */
export function agentModelTier(a: AgentModelFields): AgentModelTier {
  if (a.model === 'standard') return 'standard';
  if (a.model === 'auto') return a.model_resolved ?? 'strong';
  return 'strong';
}

/** The gateway role name for a tier. */
export function tierRole(tier: AgentModelTier): string {
  return tier === 'standard' ? ROLE_WORKER : ROLE_STRONG;
}

/** The gateway role name an agent runs on. */
export function agentModelRole(a: AgentModelFields): string {
  return tierRole(agentModelTier(a));
}

/** Why the agent runs on that model, in plain words (the run report and the builder show it). */
export function agentModelReason(a: AgentModelFields): string {
  if (a.model === 'strong') return 'set to Strong';
  if (a.model === 'standard') return 'set to Standard';
  if (a.model === 'auto') {
    if (!a.model_resolved) return 'Auto, not decided yet (decided at the next Build) — runs on Strong until then';
    return `Auto chose ${a.model_resolved === 'standard' ? 'Standard' : 'Strong'}${a.model_reason ? `: ${a.model_reason}` : ''}`;
  }
  return 'no model set — runs on Strong';
}

/** The plain-English label of a tier or choice. */
export function modelChoiceLabel(c: AgentModelChoice): string {
  return c === 'strong' ? 'Strong' : c === 'standard' ? 'Standard' : 'Auto';
}

/** A short label for the canvas: `Strong`, `Standard`, `Auto: Standard`, or `Auto` before the first Build. */
export function agentModelShort(a: AgentModelFields): string {
  if (a.model === 'auto') return a.model_resolved ? `Auto: ${modelChoiceLabel(a.model_resolved)}` : 'Auto';
  return modelChoiceLabel(agentModelTier(a));
}
