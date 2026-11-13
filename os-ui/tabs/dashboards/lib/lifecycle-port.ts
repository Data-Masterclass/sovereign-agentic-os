/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        dashboards
 * FEATURE:    The read-only port this tab uses to HONOUR stream V's lifecycle pin
 * USER STORY: As a user I want the Run view of a dashboard to render the version that is actually
 *             live, not whatever the head happens to be — and as a maintainer I want exactly one
 *             owner of the lifecycle model, which is not this tab (plan D30–D32).
 * ARCHITECTURE:
 *   - THIS TAB DOES NOT IMPLEMENT LIFECYCLE. The model, the pin, the two MCP verbs and the
 *     dependency guard are `core/kernel/lifecycle.ts` (stream V). This file is a one-function
 *     READ port with V's shape — `{ draft, testing?, live? }` keyed by `(kind, id)` — so the
 *     dashboards generator can record the pin in `dashboard.yaml` and the Run view can render it.
 *   - It exists because `core/kernel/lifecycle.ts` is not in the tree yet and a tab may not import
 *     a module that does not compile. V wires its reader in ONCE at boot via
 *     {@link setLifecycleReader}; until it does, {@link livePin} returns `null` and every surface
 *     behaves exactly as it does today — no pin, no lifecycle block in the file, no Run filter.
 *     That is the honest degradation: absent, not invented.
 *   - FAIL-OPEN BY DESIGN, and only for a READ. A missing lifecycle reader must never make a
 *     dashboard unopenable; it also must never be taken as "this is live". A caller that needs to
 *     know whether lifecycle is wired at all asks {@link lifecycleWired}.
 *   - Pure and synchronous: the generator reads the pin inside the writer's turn, so a commit
 *     records the pin as it was when the write happened.
 */

/** V's per-version lifecycle record, verbatim in shape (plan D30). */
export type LifecyclePin = {
  /** The head being edited in Studio. */
  draft?: string;
  /** The sha currently under test, when a test is in flight. */
  testing?: string;
  /** The pinned commit or tag the OS RUNS. Absent ⇒ nothing of this object is live. */
  live?: string;
};

/** The reader stream V installs: `(kind, id) → pin | null`. */
export type LifecycleReader = (kind: string, id: string) => LifecyclePin | null;

const KEY = Symbol.for('soa.dashboards.lifecycle-port');

type Port = { reader: LifecycleReader | null };

function port(): Port {
  const g = globalThis as unknown as Record<symbol, Port | undefined>;
  if (!g[KEY]) g[KEY] = { reader: null };
  return g[KEY]!;
}

/**
 * Install the lifecycle reader. Called ONCE at boot by whoever owns `core/kernel/lifecycle.ts`
 * (stream V). Returns the uninstall function, so a test can scope its own reader.
 */
export function setLifecycleReader(reader: LifecycleReader | null): () => void {
  const previous = port().reader;
  port().reader = reader;
  return () => {
    port().reader = previous;
  };
}

/** Is a lifecycle reader wired at all? Surfaces use this to say "lifecycle is not in use yet". */
export function lifecycleWired(): boolean {
  return port().reader !== null;
}

/**
 * The lifecycle pin of one dashboard, or `null` when lifecycle is not wired or this dashboard has
 * no pin. NEVER throws — a reader that throws is logged and treated as "no pin", because a
 * lifecycle hiccup may not stop a dashboard being read or committed.
 */
export function dashboardLifecycle(id: string): LifecyclePin | null {
  const reader = port().reader;
  if (!reader) return null;
  try {
    return reader('dashboard', id) ?? null;
  } catch (e) {
    console.warn(`[dashboards] lifecycle reader failed for ${id}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/**
 * The pinned LIVE version of a dashboard, or `null`. The Run view renders this; Studio renders the
 * draft. `null` means "nothing is pinned", which is NOT the same as "the head is live" — a caller
 * that wants today's behaviour (everything visible) must say so explicitly rather than read
 * `null` as live.
 */
export function livePin(id: string): string | null {
  return dashboardLifecycle(id)?.live ?? null;
}
