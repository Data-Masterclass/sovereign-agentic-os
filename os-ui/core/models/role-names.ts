/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       core / models
 * FEATURE:    The three role names, and the old names that still resolve to them for one release.
 * USER STORY: As the owner I want one place that says which three names the OS may call.
 * ARCHITECTURE: Pure constants, no imports — safe in client bundles. `role-mapping.ts` re-exports them.
 *   This file and `llm-provider-presets.ts` (placeholder text) are the only source files allowed to name an
 *   old alias (guard: `role-call-sites.guard.test.ts`).
 */
export const ROLE_NAMES = ['sovereign-strong', 'sovereign-worker', 'sovereign-embedding'] as const;
export type RoleName = (typeof ROLE_NAMES)[number];
export type RoleMapping = Record<RoleName, string>;

/** The three names, one constant each — the ONLY model names the OS puts in a request. */
export const ROLE_STRONG = 'sovereign-strong' as const;
export const ROLE_WORKER = 'sovereign-worker' as const;
export const ROLE_EMBEDDING = 'sovereign-embedding' as const;

/** Old names (and the roles they stand for) that mean `strong`: they may see images, like the role itself. */
export const strongAliases = (): string[] => Object.entries(DEPRECATED_ALIASES).filter(([, r]) => r === ROLE_STRONG).map(([a]) => a);

/** Old names that still work for one release, and the role each one now stands for. */
export const DEPRECATED_ALIASES: Readonly<Record<string, RoleName>> = {
  'sovereign-default': 'sovereign-worker',
  'sovereign-mock': 'sovereign-worker',
  'sovereign-reasoning': 'sovereign-strong',
  'sovereign-reasoning-fast': 'sovereign-strong',
  'sovereign-premium': 'sovereign-strong',
  'sovereign-vision': 'sovereign-strong',
  'sovereign-embed': 'sovereign-embedding',
};

