/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Named health warnings a background loop raises when it cannot do its job
 * USER STORY: As an operator I want a timer that cannot reach its upstream to say so on `/api/status`
 *             (next to the store hydration warnings) instead of failing silently in a log nobody reads.
 * ARCHITECTURE: a process-wide map name → message, set while the condition holds and cleared by the
 *   next good pass. Read by `app/api/status/route.ts`. In-process on purpose: each pod reports its own loop.
 */
const KEY = Symbol.for('sovereign-os.health-warnings');

function warnings(): Map<string, { message: string; at: string }> {
  const g = globalThis as unknown as Record<symbol, Map<string, { message: string; at: string }> | undefined>;
  return (g[KEY] ??= new Map());
}

export function setHealthWarning(name: string, message: string): void {
  warnings().set(name, { message, at: new Date().toISOString() });
}

export function clearHealthWarning(name: string): void {
  warnings().delete(name);
}

export function getHealthWarning(name: string): string | null {
  return warnings().get(name)?.message ?? null;
}

/** Every active warning, as one line each (with the time it was raised). */
export function healthWarnings(): string[] {
  return [...warnings().values()].map((w) => `${w.message} (since ${w.at})`);
}
