/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * PLAN-ITEM grant encoding — how an Operating Model, a Strategic Pillar or a Big Bet
 * is named in `grants.plan`. A plan item is not a free artifact id; its grant `id`
 * encodes the plan target so the runtime knows WHICH governed thing to load:
 *
 *   Operating Model → `manual:my` · `manual:domain` · `manual:company`
 *   Strategic Pillar → `pillar:<pillarId>`
 *   Big Bet          → `bigbet:<betId>`
 *
 * The manual scope maps to the SAME `resolveManual` gate the Operating-Manual tab uses,
 * so a granted manual is loaded under the caller's own DLS/scope check at run time via
 * the governed `get_operating_manual` tool. A pillar/bet grant records the exact
 * governed target id; granting provisions the matching read tool (`get_pillar` /
 * `get_big_bet`, + the discovery `list_*`), which itself RLS/scope-checks the request in
 * the strategy / big-bets store at run time — nothing is pre-injected and nothing
 * widens (the granted read tool + authorized principal + in-store DLS check IS the
 * injection; there is no pre-built context pack in this OS).
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
const PILLAR_PREFIX = 'pillar:';
const BIGBET_PREFIX = 'bigbet:';

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
  if (scope === 'my') return 'My Operating Model';
  if (scope === 'domain') return 'Domain Operating Model';
  return 'Company Operating Model';
}

/** The grants-available `scope` bucket an Operating-Manual scope shows under. */
export function manualAvailableScope(scope: ManualScope): 'personal' | 'domain' | 'marketplace' {
  if (scope === 'my') return 'personal';
  if (scope === 'domain') return 'domain';
  return 'marketplace'; // company ↔ "Company" bucket (marketplace lane), matching scopeLabel
}

// ─── Strategic Pillar / Big Bet plan grants ──────────────────────────────────

/** The `grants.plan` id for a Strategic Pillar. `pillarPlanId('p_1') → 'pillar:p_1'`. */
export function pillarPlanId(pillarId: string): string {
  return `${PILLAR_PREFIX}${pillarId}`;
}

/** Parse a plan-grant id back to its Pillar id, or `null` if it isn't a pillar grant. */
export function pillarIdOfPlanId(id: string): string | null {
  if (!id.startsWith(PILLAR_PREFIX)) return null;
  const pid = id.slice(PILLAR_PREFIX.length);
  return pid.length > 0 ? pid : null;
}

/** The `grants.plan` id for a Big Bet. `bigBetPlanId('bet_1') → 'bigbet:bet_1'`. */
export function bigBetPlanId(betId: string): string {
  return `${BIGBET_PREFIX}${betId}`;
}

/** Parse a plan-grant id back to its Big-Bet id, or `null` if it isn't a bet grant. */
export function bigBetIdOfPlanId(id: string): string | null {
  if (!id.startsWith(BIGBET_PREFIX)) return null;
  const bid = id.slice(BIGBET_PREFIX.length);
  return bid.length > 0 ? bid : null;
}

/** The kind of plan target a `grants.plan` id encodes (for tool provisioning + labels). */
export type PlanTarget = 'manual' | 'pillar' | 'bigbet' | null;

/** Classify a plan-grant id. `null` for anything that isn't a recognised plan target. */
export function planTargetOf(id: string): PlanTarget {
  if (manualScopeOfPlanId(id)) return 'manual';
  if (pillarIdOfPlanId(id)) return 'pillar';
  if (bigBetIdOfPlanId(id)) return 'bigbet';
  return null;
}
