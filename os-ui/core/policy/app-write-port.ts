/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The seam that runs an approved app write
 * USER STORY: As an approver who approves a write a Software app asked for, I want the write to
 *             actually happen (or the approval to say why it could not), not to be cleared as if
 *             it had run.
 * ARCHITECTURE:
 *   - A REGISTRATION, never a core→tab import (the same shape as the approval-resume hook): the
 *     Software tab owns how an app tool runs, and the entrypoint (`instrumentation.ts`) registers
 *     it here at boot. `buildEffectDeps` (ladder.ts) reads it at call time, so `applyEffect`
 *     stays free of any tab.
 *   - Nothing registered ⇒ `null`, and the effect says so (`ok:false`) instead of pretending.
 */

/** The held app write as the app door filed it. */
export type AppWriteRequest = {
  appId: string;
  tool: string;
  args: Record<string, unknown>;
  /** The signed-in user whose app call was held. Their records are the ones written. */
  requestedBy: string;
};

export type AppWriteOutcome = { ok: boolean; reason: string };

export type AppWriteApplier = (req: AppWriteRequest) => Promise<AppWriteOutcome>;

const KEY = Symbol.for('sovereign-os.app-write-applier');

/** Register the process's applier. Returns the unregister function (tests). */
export function registerAppWriteApplier(fn: AppWriteApplier): () => void {
  const g = globalThis as unknown as Record<symbol, AppWriteApplier | undefined>;
  g[KEY] = fn;
  return () => {
    if (g[KEY] === fn) delete g[KEY];
  };
}

/** The registered applier, or null when none is registered in this process. */
export function appWriteApplier(): AppWriteApplier | null {
  return (globalThis as unknown as Record<symbol, AppWriteApplier | undefined>)[KEY] ?? null;
}
