/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * The AGENTS app-grant model — the SIXTH grantable Choose-Context type
 * (Data · Metrics · Files · Knowledge · Connections live in the OS-wide core
 * `ContextGrants`; Agents rides HERE).
 *
 * Agents are how INTELLIGENCE enters a declarative app (DESIGN.md "Context &
 * capabilities"): an app never calls the raw LLM — it grants a governed, evaluated,
 * role-gated agent built in the Agents tab and (Phase 4c) invokes it at runtime via a
 * "Run agent" action. Phase 4b RECORDS the grant only; the invocation is 4c.
 *
 * Kept as a SEPARATE, additive field on `App` rather than a sixth kind of the shared
 * `ContextGrants` primitive, because that primitive is an OS-wide contract shared with
 * the Agents builder's own grant picker — widening it there would ripple. This module
 * is pure + client-safe (no server-only / Next imports) so the picker UI and the unit
 * tests share ONE source of truth, mirroring `lib/core/context-grants.ts`.
 */

import { CONTEXT_ACCESS_LEVELS, type ContextAccess } from '@/lib/core/context-grants';

/** One granted agent: its system id plus the access the app holds on it. Access reuses
 *  the core `ContextAccess` ladder so the safety cap + selector behave identically to
 *  every other kind (an agent grant is a READ/RUN grant — it never widens the agent's
 *  own ⊆ grants, which stay governed on the Agents side). */
export type AppAgentGrant = { id: string; access: ContextAccess };

/** The empty agents-grant list — the persisted default (a legacy app loads as `[]`). */
export function emptyAgentGrants(): AppAgentGrant[] {
  return [];
}

/**
 * Normalise a possibly-partial / legacy value into a clean `AppAgentGrant[]`, so an app
 * persisted BEFORE the agents grant existed (undefined) still loads. Non-arrays and
 * malformed rows are dropped; each kept row carries a valid id + access.
 */
export function normalizeAgentGrants(v: unknown): AppAgentGrant[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((g): g is AppAgentGrant =>
      !!g && typeof g === 'object' &&
      typeof (g as AppAgentGrant).id === 'string' &&
      CONTEXT_ACCESS_LEVELS.includes((g as AppAgentGrant).access),
    )
    .map((g) => ({ id: g.id, access: g.access }));
}

/** Whether `id` is granted at all. */
export function isAgentGranted(grants: AppAgentGrant[], id: string): boolean {
  return grants.some((g) => g.id === id);
}

/** The access an agent grant currently holds, or 'read-only' if not granted. */
export function agentAccessOf(grants: AppAgentGrant[], id: string): ContextAccess {
  return grants.find((g) => g.id === id)?.access ?? 'read-only';
}

/**
 * Return a NEW agents-grant list with `id` set to `access`. Passing `null` removes the
 * grant. Pure — never mutates the input. (No cap clamp: an agent grant is READ/RUN; the
 * access field exists only for shape-parity with the other kinds and defaults read-only.)
 */
export function setAgentGrant(
  grants: AppAgentGrant[],
  id: string,
  access: ContextAccess | null,
): AppAgentGrant[] {
  const rest = grants.filter((g) => g.id !== id);
  return access === null ? rest : [...rest, { id, access }];
}
