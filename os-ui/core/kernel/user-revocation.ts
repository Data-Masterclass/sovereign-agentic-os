/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       kernel
 * FEATURE:    What happens to a user's sign-ins when the user is deactivated or offboarded
 * USER STORY: As an admin I want deactivating someone — from the Access page, an offboarding or a
 *             domain delete — to revoke the accounts they connected (Notion, Microsoft, Google),
 *             whichever path did it.
 * ARCHITECTURE:
 *   - A registry, not an import graph: the kernel must not know its tabs, so the Connections tab
 *     registers its revoke at boot (instrumentation.ts), and the user store (`tabs/admin`) calls
 *     `revokeUserEverywhere` from `deactivateUser` and `offboardUser` — the one place every path
 *     goes through. Same shape as `lifecycle-adapters.ts`.
 *   - globalThis-pinned, so every route bundle sees the same registry.
 *   - A revoke that fails is raised, never swallowed: the caller reports it.
 *   - Fail-closed wiring: the revokes in `REQUIRED_USER_REVOCATIONS` must be registered, else
 *     `revokeUserEverywhere` throws (a deactivation that silently revoked nothing is the bug this
 *     prevents). Under `node --test` only, `scripts/test-setup.mjs` may relax that for suites that
 *     deactivate users without loading the Connections tab (the same seam style as the workflow gate).
 */

export type UserRevocationHook = (userId: string) => Promise<number>;

/** The revokes every deployment must have wired (registered in instrumentation.ts). Names, not imports. */
export const REQUIRED_USER_REVOCATIONS: readonly string[] = ['connections'];
const TEST_OPTIONAL = Symbol.for('soa.test.userRevocationOptional');

function wiringRelaxedForTests(): boolean {
  const g = globalThis as unknown as Record<symbol, unknown>;
  return !!process.env.NODE_TEST_CONTEXT && g[TEST_OPTIONAL] === true;
}

const KEY = Symbol.for('soa.kernel.user-revocation');
function hooks(): Map<string, UserRevocationHook> {
  const g = globalThis as unknown as Record<symbol, Map<string, UserRevocationHook> | undefined>;
  if (!g[KEY]) g[KEY] = new Map();
  return g[KEY]!;
}

export function registerUserRevocation(name: string, fn: UserRevocationHook): void {
  hooks().set(name, fn);
}

export function registeredUserRevocations(): string[] {
  return [...hooks().keys()];
}

/** Run every registered revoke for a user. Returns how many credentials each one removed. */
export async function revokeUserEverywhere(userId: string): Promise<Record<string, number>> {
  const missing = REQUIRED_USER_REVOCATIONS.filter((n) => !hooks().has(n));
  if (missing.length && !wiringRelaxedForTests()) {
    throw new Error(`Revoking ${userId}'s connected accounts is not wired (${missing.join(', ')} not registered); nothing was revoked`);
  }
  const out: Record<string, number> = {};
  const failures: string[] = [];
  for (const [name, fn] of hooks()) {
    try {
      out[name] = await fn(userId);
    } catch (e) {
      failures.push(`${name}: ${(e as Error)?.message ?? String(e)}`);
    }
  }
  if (failures.length) throw new Error(`Revoking ${userId}'s connected accounts failed (${failures.join('; ')})`);
  return out;
}

export function __resetUserRevocations(): void {
  hooks().clear();
}
