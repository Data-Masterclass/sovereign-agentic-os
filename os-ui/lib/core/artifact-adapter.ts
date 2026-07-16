/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * THE ARTIFACT ADAPTER CONTRACT — the ONE seam every foldered tab (Files, Data,
 * Knowledge, Metrics) plugs into so the folder LIFECYCLE (move / archive / restore /
 * delete cascade) is written ONCE in core and never drifts per tab.
 *
 * This mirrors two idioms already in the codebase: the warehouse provider registry
 * (`lib/connections/warehouse/registry.ts` → one map of providers) and the tutorial
 * registry. A tab implements a thin `ArtifactAdapter` wrapping its OWN store's item
 * ops and registers it at import; `lib/folders/folder-lifecycle.ts` then orchestrates
 * the folder-row op + a CASCADE over member items THROUGH the adapter.
 *
 * LAYERING: `lib/core` is the bottom layer, so this module defines the INTERFACE + a
 * tiny registry only — it imports NOTHING from `lib/infra`, `lib/governance` or any
 * tab store. The adapters themselves live in each tab's module (which may import
 * infra/governance) and register here at boot; the folder store (`lib/folders`) reads
 * them. Never the other way round.
 *
 * PERMISSIONS: every `*Item` method MUST run the tab's own edit-scope gate
 * (`canManageArtifact`) and THROW (with a `.status` of 403) when the caller may not
 * act. The core cascade is FAIL-CLOSED: it never swallows a governance throw — a
 * single denied member surfaces and aborts, so a cascade can never partially bypass
 * governance.
 */

/** The acting principal — id/role/domains the tab's edit-scope gate reads. */
export type AdapterPrincipal = { id: string; role: string; domains: string[] };

/** The folder scope an item lives in — tier-bound (personal vs shared/domain). */
export type AdapterScope = 'personal' | 'domain';

/** The minimum a member item exposes to the cascade: an id + its folder path. */
export type AdapterItem = { id: string; folder: string };

/**
 * One tab's binding to the shared folder lifecycle. Each method wraps an existing
 * store function; the cascade calls them per-item, relying on each to run its own
 * governance gate and throw 403 when denied.
 */
export type ArtifactAdapter = {
  /** The tab namespace — matches `FolderTab` (`files` | `data` | `knowledge` | `metrics`). */
  tab: string;
  /** Every item the caller may see under `path` (incl. subfolders) in `scope`. Already
   *  DLS-scoped by the store, so the cascade can only ever touch a permitted subset.
   *  MUST include ARCHIVED members too (the restore/delete cascade needs to find items
   *  the archive step already hid), and MUST return items in the given scope's lane
   *  only (personal vs domain) so a cascade never crosses tiers. */
  itemsUnderFolder(user: AdapterPrincipal, scope: AdapterScope, path: string): AdapterItem[];
  /** Re-parent one item to `path` (edit-scoped; throws 403 when denied). */
  moveItem(id: string, user: AdapterPrincipal, path: string): void;
  /** Reversible soft-archive one item (edit-scoped; throws 403 when denied). */
  archiveItem(id: string, user: AdapterPrincipal): void;
  /** Reverse the soft-archive (edit-scoped; throws 403 when denied). */
  restoreItem(id: string, user: AdapterPrincipal): void;
  /** PHYSICAL, permanent delete of one item (edit-scoped; throws 403 when denied). */
  deleteItem(id: string, user: AdapterPrincipal): void;
};

// ------------------------------------------------------------------ registry --

const REGISTRY_KEY = Symbol.for('soa.core.artifact-adapters');
function registry(): Map<string, ArtifactAdapter> {
  const g = globalThis as unknown as Record<symbol, Map<string, ArtifactAdapter> | undefined>;
  if (!g[REGISTRY_KEY]) g[REGISTRY_KEY] = new Map();
  return g[REGISTRY_KEY]!;
}

/** Register (or replace) a tab's adapter. Idempotent per `tab` — a re-import wins. */
export function registerArtifactAdapter(adapter: ArtifactAdapter): void {
  registry().set(adapter.tab, adapter);
}

/** Resolve a tab's adapter, or `undefined` when none is registered. */
export function getArtifactAdapter(tab: string): ArtifactAdapter | undefined {
  return registry().get(tab);
}

/** Test hook: forget every registered adapter. */
export function __resetArtifactAdapters(): void {
  registry().clear();
}
