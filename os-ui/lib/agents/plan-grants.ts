/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * PLAN-ITEM grant encoding — how an Operating Manual (and, later, a Strategic Pillar /
 * Big Bet) is named in `grants.plan`. A plan item is not a free artifact id; its grant
 * `id` encodes the plan target so the runtime knows WHICH governed thing to load:
 *
 *   Operating Manual → `manual:my` · `manual:domain` · `manual:company`
 *
 * The scope maps to the SAME `resolveManual` gate the Operating-Manual tab uses, so a
 * granted manual is loaded under the caller's own DLS/scope check at run time via the
 * governed `get_operating_manual` tool — nothing is pre-injected and nothing widens.
 *
 * DOMAIN manual is the org's shared "how we operate" card everyone in-domain already
 * reads; granting the DOMAIN manual simply makes the agent load it explicitly (there is
 * NO silent base auto-injection in the agent runtime — verified — so this is the only
 * way the manual reaches the agent, and it is honest + not a double-inject).
 *
 * PURE + client-safe (no server/Next imports) so the UI, the available route and the
 * unit tests share ONE encoding.
 */

export type ManualScope = 'my' | 'domain' | 'company';
export const MANUAL_SCOPES: ManualScope[] = ['my', 'domain', 'company'];

const MANUAL_PREFIX = 'manual:';

/** The `grants.plan` id for an Operating-Manual scope. `manualPlanId('my') → 'manual:my'`. */
export function planGrantId(scope: ManualScope): string {
  return `${MANUAL_PREFIX}${scope}`;
}

/** Parse a plan-grant id back to its Operating-Manual scope, or `null` if it isn't one. */
export function manualScopeOfPlanId(id: string): ManualScope | null {
  if (!id.startsWith(MANUAL_PREFIX)) return null;
  const s = id.slice(MANUAL_PREFIX.length);
  return (MANUAL_SCOPES as string[]).includes(s) ? (s as ManualScope) : null;
}

/** The human label for an Operating-Manual scope, matching the OS My/Domain/Company vocabulary. */
export function manualLabel(scope: ManualScope): string {
  if (scope === 'my') return 'My Operating Manual';
  if (scope === 'domain') return 'Domain Operating Manual';
  return 'Company Operating Manual';
}

/** The grants-available `scope` bucket an Operating-Manual scope shows under. */
export function manualAvailableScope(scope: ManualScope): 'personal' | 'domain' | 'marketplace' {
  if (scope === 'my') return 'personal';
  if (scope === 'domain') return 'domain';
  return 'marketplace'; // company ↔ "Company" bucket (marketplace lane), matching scopeLabel
}
