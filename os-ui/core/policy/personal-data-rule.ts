/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The admin setting "Personal data before Company certification", as the kernel reads it
 * USER STORY: As a platform admin I decide whether a dataset with personal-data columns that are
 *             neither masked nor hidden may be certified to Company (readable by every domain):
 *             refused (`block`, the default), allowed after the certifier confirms with a reason
 *             (`confirm`), or not checked (`off`).
 * ARCHITECTURE:
 *   - The VALUE is an admin setting, stored with every other tenant setting in
 *     `tabs/admin/lib/settings.ts` (durable mirror, audited admin-only PATCH). That module PUBLISHES
 *     the value here on every hydrate / update / restore, so the Data tab's certify choke point reads
 *     it through the kernel and never imports another tab (GLUE-9).
 *   - FAIL-CLOSED: until the settings store has answered (`known`), the EFFECTIVE rule is `block`,
 *     whatever the default or the held value — a pod that could not read the setting never lets
 *     personal data through to every domain. A door that wants the saved rule hydrates the
 *     settings first (the certify / approval routes and the MCP server do).
 *   - Pinned on globalThis so every separately bundled route shares one value.
 */

export type PersonalDataRule = 'block' | 'confirm' | 'off';
export const PERSONAL_DATA_RULES: readonly PersonalDataRule[] = ['block', 'confirm', 'off'];
export const DEFAULT_PERSONAL_DATA_RULE: PersonalDataRule = 'block';

export function isPersonalDataRule(v: unknown): v is PersonalDataRule {
  return typeof v === 'string' && (PERSONAL_DATA_RULES as readonly string[]).includes(v);
}

/** Nil-safe: a known rule is kept, anything else keeps `fallback`. */
export function normalizePersonalDataRule(v: unknown, fallback: PersonalDataRule = DEFAULT_PERSONAL_DATA_RULE): PersonalDataRule {
  return isPersonalDataRule(v) ? v : fallback;
}

type State = { rule: PersonalDataRule; known: boolean };
const KEY = Symbol.for('soa.policy.personal-data-rule');
function state(): State {
  const g = globalThis as unknown as Record<symbol, State | undefined>;
  if (!g[KEY]) g[KEY] = { rule: DEFAULT_PERSONAL_DATA_RULE, known: false };
  return g[KEY]!;
}

/** Called by the settings store only: the saved rule, and whether the store has answered. */
export function publishPersonalDataRule(rule: PersonalDataRule, known: boolean): void {
  const s = state();
  s.rule = normalizePersonalDataRule(rule);
  s.known = known;
}

/** The rule the certify gate applies: the saved one once read, `block` until then. */
export function effectivePersonalDataRule(): { rule: PersonalDataRule; saved: PersonalDataRule; known: boolean } {
  const s = state();
  return { rule: s.known ? s.rule : 'block', saved: s.rule, known: s.known };
}

/** Test-only: forget the published value (a fresh process). */
export function __resetPersonalDataRule(): void {
  const s = state();
  s.rule = DEFAULT_PERSONAL_DATA_RULE;
  s.known = false;
}
