/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The seam through which kernel code asks "which grants can this user not use?"
 * USER STORY: As a builder creating or committing an agent system over MCP I want the same grant
 *             warnings the Agents tab shows — and, when they cannot be computed, to be told so.
 * ARCHITECTURE:
 *   - The kernel never imports a tab. The Agents tab owns the check
 *     (`tabs/agents/lib/build/grant-access-probe.ts`) and installs it here at boot
 *     (`instrumentation.ts`), exactly like the lifecycle adapters.
 *   - NEVER THROWS, NEVER SILENT. A save must not be blocked by the check, so every failure
 *     becomes `{ checked: false, reason }` — a result that says the check did not run, which a
 *     caller surfaces ("Grant check could not run: …") instead of an empty, all-clear list.
 */
import type { CurrentUser } from '@core/kernel/auth';

/** One grant the user cannot use — the kernel's structural view of the tab's `GrantWarning`. */
export type GrantCheckWarning = {
  kind: string;
  id?: string;
  folder?: { path: string; scope: string };
  capability: string;
  status: string;
  message: string;
};

/** Either the check ran (possibly with no warnings), or it did not — and why. */
export type GrantCheckOutcome =
  | { checked: true; warnings: GrantCheckWarning[] }
  | { checked: false; warnings: GrantCheckWarning[]; reason: string };

export type GrantCheckPort = {
  /** The warnings for a system.yaml text, as `user`. May throw; the port catches. */
  forYaml(user: CurrentUser, yaml: string): Promise<GrantCheckOutcome>;
};

const KEY = Symbol.for('soa.core.grant-check-port');
type Slot = { port: GrantCheckPort | null };
function slot(): Slot {
  const g = globalThis as unknown as Record<symbol, Slot | undefined>;
  if (!g[KEY]) g[KEY] = { port: null };
  return g[KEY]!;
}

/** Install (or, with `null`, remove) the check. Idempotent — the last registration wins. */
export function registerGrantCheckPort(port: GrantCheckPort | null): void {
  slot().port = port;
}

/** A not-run outcome naming why. */
export function grantCheckNotRun(reason: string): GrantCheckOutcome {
  return { checked: false, warnings: [], reason };
}

/**
 * The response fields every door returns: `grantWarnings` (the list) and `grantCheck`
 * (`{ checked: true }` or `{ checked: false, reason }`) — so "no warnings" and "the check did
 * not run" can never be confused by a client.
 */
export function grantCheckFields<W>(o: { checked: true; warnings: W[] } | { checked: false; warnings: W[]; reason: string }): {
  grantWarnings: W[];
  grantCheck: { checked: true } | { checked: false; reason: string };
} {
  return { grantWarnings: o.warnings, grantCheck: o.checked ? { checked: true } : { checked: false, reason: o.reason } };
}

/** Run the registered check. Never throws: an absent port or a failure is a typed not-run. */
export async function runGrantCheckForYaml(user: CurrentUser, yaml: string): Promise<GrantCheckOutcome> {
  const port = slot().port;
  if (!port) return grantCheckNotRun('the grant check is not registered in this process');
  try {
    return await port.forYaml(user, yaml);
  } catch (e) {
    return grantCheckNotRun(`grant check unavailable: ${e instanceof Error ? e.message : String(e)}`);
  }
}
