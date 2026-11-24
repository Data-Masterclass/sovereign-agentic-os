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
 */

export type UserRevocationHook = (userId: string) => Promise<number>;

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
