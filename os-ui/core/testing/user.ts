/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       kernel (test support)
 * FEATURE:    `testUser()` — the ONE way a test builds a `CurrentUser`
 * USER STORY: As a maintainer I want the test suite to type-check, and I want adding a required
 *             field to `CurrentUser` to be a one-line change here instead of 500 edits across the
 *             suites — which is exactly the bill Part F's F-5 measured.
 * ARCHITECTURE:
 *   - Part F found 599 type errors in the test tree, of which **510 are one shape**: a test-local
 *     `CurrentUser` object literal that omits `allDomains` and `activeDomain`. Both are required,
 *     both are load-bearing in production (`domains` is the ACTIVE scope, `allDomains` is every
 *     membership), so relaxing the type would weaken the real contract to please the tests. The
 *     fix is a factory that fills them CONSISTENTLY instead.
 *   - DEFAULTS THAT MATCH REALITY, not blanks: `allDomains` defaults to `domains` and
 *     `activeDomain` to `domains[0] ?? null`, which is what `auth.ts` produces for a user acting
 *     in a single domain — the common case every one of those literals meant. A test that needs a
 *     user with several memberships acting in one of them passes both explicitly.
 *   - It lives in `core/` so `core/**` and `tabs/**` suites can both import it through `@core/*`
 *     without crossing the tab-isolation rule (a `tabs/.../test-helpers` would be unreachable from
 *     another tab). It imports nothing but a type, so it costs the bundle nothing it would not
 *     already carry, and `core/` still imports no tab.
 */
import type { CurrentUser } from '@core/kernel/auth';
import type { Role } from '@core/kernel/session';

export type TestUserInput = {
  id: string;
  name?: string;
  role?: Role;
  /** The ACTIVE scope (what lists and create-defaults read). Defaults to `['sales']`. */
  domains?: string[];
  /** Every membership. Defaults to `domains` — a user acting across all the domains they are in. */
  allDomains?: string[];
  /** The chosen active domain. Defaults to `domains[0] ?? null`, never `undefined`. */
  activeDomain?: string | null;
};

/**
 * Build a complete `CurrentUser` for a test. Every field the type requires is filled, so a new
 * required field becomes ONE edit here rather than one per suite.
 *
 * ```ts
 * const amir = testUser({ id: 'amir', domains: ['sales'], role: 'creator' });
 * const admin = testUser({ id: 'sara', role: 'admin', domains: ['ops'], allDomains: ['ops', 'sales'] });
 * ```
 */
export function testUser(input: TestUserInput): CurrentUser {
  const domains = input.domains ?? ['sales'];
  return {
    id: input.id,
    name: input.name ?? input.id,
    domains,
    allDomains: input.allDomains ?? domains,
    activeDomain: input.activeDomain !== undefined ? input.activeDomain : (domains[0] ?? null),
    role: input.role ?? 'creator',
  };
}
