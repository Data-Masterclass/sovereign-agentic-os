/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       kernel
 * FEATURE:    The per-kind lifecycle adapter registry — how the kernel asks a tab about an object
 * USER STORY: As a maintainer I want ONE go-live verb and ONE guard for every kind, so each tab
 *             contributes only the three facts that are genuinely kind-specific (what the object
 *             is, what it depends on, and what starts running when it goes live) instead of each
 *             tab growing its own half-correct copy of the lifecycle.
 * ARCHITECTURE:
 *   - A registry, not an import graph: the kernel must not know its tabs, so each tab registers
 *     its own adapter at boot (instrumentation.ts) and the kernel only ever sees this interface.
 *     Same shape as the engineering-view adapter registry.
 *   - PURE: a globalThis-pinned Map and three functions. No I/O of its own, no server-only, so a
 *     test registers a fake adapter and drives the whole go-live path offline.
 *   - Every adapter method takes the ACTING USER and resolves as that user. An adapter that reads
 *     under a service principal would widen identity; `resolve` throwing 403/404 is the contract.
 *   - A kind with no registered adapter is an honest, typed refusal — never a silent success.
 */

import type { LifecycleKind } from '@core/kernel/object-lifecycle';

/** The acting principal, exactly as the governed stores expect it. */
export type LifecycleActor = {
  id: string;
  name?: string | null;
  email?: string | null;
  role: string;
  domains: string[];
};

/** One object, resolved as the acting user. */
export type LifecycleObject = {
  kind: LifecycleKind;
  id: string;
  /** Display name, for the refusal message and the confirm dialog. */
  name: string;
  /** The domain whose repo carries the pin. */
  domain: string;
  /** The object's current EDITABLE ref — a commit sha, or `v<n>` for a version-log kind. */
  head: string;
  /** The persisted tier/visibility, for the audience badge only. Never a lifecycle input. */
  tier: string;
};

/** A dependency, named but not yet resolved to a lifecycle (the service does that). */
export type DependencyRef = { kind: LifecycleKind; id: string; name: string };

export type Permission = { ok: true } | { ok: false; reason: string };

/**
 * What one kind must tell the kernel. Only `kind`, `resolve` and `canGoLive` are required:
 * an object with no dependencies and nothing scheduled is a perfectly valid lifecycle citizen.
 */
export type LifecycleAdapter = {
  kind: LifecycleKind;
  /** Resolve as the acting user, or throw with `status` 403/404. Never widen identity. */
  resolve(actor: LifecycleActor, id: string): Promise<LifecycleObject>;
  /** May this user change WHAT RUNS for this object? (Owner, or an in-domain admin.) */
  canGoLive(actor: LifecycleActor, obj: LifecycleObject): Promise<Permission>;
  /** The object's dependencies, in the order a refusal should name them. */
  dependencies?(actor: LifecycleActor, obj: LifecycleObject): Promise<DependencyRef[]>;
  /** What starts running, in the TOOL's own words — the confirm dialog's sentence. */
  consequences?(actor: LifecycleActor, obj: LifecycleObject): Promise<string[]>;
  /** Every object of this kind that exists, for the one-time "everything is Live" migration. */
  existing?(): Promise<{ id: string; head: string; domain: string }[]>;
};

type RegistryState = { byKind: Map<LifecycleKind, LifecycleAdapter> };
const STATE_KEY = Symbol.for('soa.lifecycle.adapters');

function state(): RegistryState {
  const g = globalThis as unknown as Record<symbol, RegistryState | undefined>;
  if (!g[STATE_KEY]) g[STATE_KEY] = { byKind: new Map() };
  return g[STATE_KEY]!;
}

/** Register (or replace) the adapter for one kind. Idempotent; last registration wins. */
export function registerLifecycleAdapter(adapter: LifecycleAdapter): void {
  state().byKind.set(adapter.kind, adapter);
}

/** The adapter for a kind, or undefined when that kind has not registered one yet. */
export function lifecycleAdapterFor(kind: string): LifecycleAdapter | undefined {
  return state().byKind.get(kind as LifecycleKind);
}

/** Every kind that can currently go live, sorted — what `go_live`'s schema advertises. */
export function registeredLifecycleKinds(): LifecycleKind[] {
  return [...state().byKind.keys()].sort();
}

/** Test seam. */
export function __clearLifecycleAdapters(): void {
  state().byKind.clear();
}
