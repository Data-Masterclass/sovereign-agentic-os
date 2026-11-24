/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The admin's tool-console switches (Platform → Tool consoles), as the kernel and other
 *             tabs read them
 * USER STORY: As an engineer on a data product's "Under the hood" panel I am offered "Open in
 *             Dagster" only when that console is actually reachable for me: I am an admin and the
 *             console is switched on.
 * ARCHITECTURE:
 *   - The VALUE is an admin setting (`settings.toolConsoles`, tabs/admin/lib/settings.ts: durable
 *     mirror, audited admin-only PATCH). That module PUBLISHES it here on every hydrate / update /
 *     restore — the pattern of core/policy/personal-data-rule.ts — so another tab reads it through
 *     the kernel and never imports the admin tab (GLUE-9).
 *   - FAIL-CLOSED: until the settings store has answered (`known`), every console reads as OFF.
 *   - Pinned on globalThis so every separately bundled route shares one value.
 */

type State = { exposed: Record<string, boolean>; known: boolean };
const KEY = Symbol.for('soa.infra.tool-console-state');
function state(): State {
  const g = globalThis as unknown as Record<symbol, State | undefined>;
  if (!g[KEY]) g[KEY] = { exposed: {}, known: false };
  return g[KEY]!;
}

/** Called by the settings store only: each tool's switch, and whether the store has answered. */
export function publishToolConsoles(consoles: Record<string, { exposed: boolean }>, known: boolean): void {
  const s = state();
  const next: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(consoles ?? {})) next[k] = v?.exposed === true;
  s.exposed = next;
  s.known = known;
}

/** Is this console switched on? `false` until the store has answered, and for any unknown key. */
export function toolConsoleOn(key: string): { on: boolean; known: boolean } {
  const s = state();
  const on = s.known && Object.prototype.hasOwnProperty.call(s.exposed, key) && s.exposed[key] === true;
  return { on, known: s.known };
}

/** Test-only: forget the published value (a fresh process). */
export function __resetToolConsoleState(): void {
  const s = state();
  s.exposed = {};
  s.known = false;
}
