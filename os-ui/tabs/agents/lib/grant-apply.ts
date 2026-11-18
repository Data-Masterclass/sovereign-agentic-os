/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       agents
 * FEATURE:    Turn a folder-tree selection into grant edits WITHOUT deleting what the tree cannot see
 * USER STORY: As an author I tick a folder in my team's domain and every other grant the team
 *             already holds is still there afterwards.
 * ARCHITECTURE:
 *   - Lifted out of `GrantPickers.tsx` so the round trip is unit-testable: a test cannot import
 *     a `.tsx` (Node strips types but not JSX). The component now only wires it.
 *   - The reconcile is a DIFF against what the tree could actually show, not against the whole
 *     system. That distinction is the fix for a real defect: once the grant feed is narrowed to
 *     the system's domain, a folder grant pointing elsewhere has no items in the feed —
 *     `triState` calls an item-less folder 'none' and `computeSelection` skips it — so the
 *     emitted selection omits it. Reading that omission as "the user unticked it" DELETED a live
 *     grant on the first tick. The same held for an item grant whose id the feed stopped listing.
 *   - Hence two inputs that bound removal: `listedItemIds` (what the feed showed) and
 *     `protectedFolders` (nodes deliberately kept OUT of the tree). Pass neither and nothing is
 *     removed — unknown universe ⇒ no destruction, never the other way round.
 *   - Per-item write capabilities are preserved: an id that stays selected is left ALONE rather
 *     than re-set at the Read default.
 */
import {
  setArtifactGrant, removeArtifactGrant, setFolderGrant, removeFolderGrant,
} from '@tabs/agents/lib/simple-edit';
import { normaliseFolderPath } from '@core/kernel/folders';
import type { System, DataLayer } from '@tabs/agents/lib/system-schema';

/** The foldered grant kinds the tree edits. */
export type FolderedGrantKind = 'data' | 'knowledge' | 'files';

/** A folder reference `{path, scope}` — structurally the FolderTree's `FolderGrant`.
 *  Declared here rather than imported so this module pulls in no `.tsx`. */
export type FolderRef = { path: string; scope: 'personal' | 'domain' };

/** What the tree emits — structurally the FolderTree's `FolderSelection`. */
export type TreeSelection = { folderGrants: FolderRef[]; itemGrants: string[] };

export type ApplyOpts = {
  /** When the knowledge feed is split into Workflows vs Knowledge, each picker reconciles
   *  ONLY its own item family so it never removes the other's grants. */
  inFamily?: (id: string) => boolean;
  /** False for the Workflows picker (workflows carry no folders) — folder grants untouched. */
  manageFolders?: boolean;
  /**
   * The item ids the feed could actually show. An existing item grant OUTSIDE this set was
   * never offered to the tree, so its absence from the selection means nothing and it is
   * kept. Omit ⇒ the universe is unknown ⇒ no item grant is removed.
   */
  listedItemIds?: Iterable<string>;
  /**
   * Folder grants the feed flagged as outside the system's domain. They are rendered as
   * read-only chips rather than tree nodes, so the tree can never emit them; they are kept.
   */
  protectedFolders?: FolderRef[];
};

/** The folder grants of a kind currently on the system (each `{path,scope}`). */
export function folderGrantsOf(system: System, kind: FolderedGrantKind): FolderRef[] {
  return system.grants[kind]
    .filter((g) => g.folder)
    .map((g) => ({ path: g.folder!.path, scope: g.folder!.scope }));
}

const keyOf = (f: { path: string; scope: string }) => `${f.scope}:${normaliseFolderPath(f.path)}`;

/**
 * Apply a folder-tree selection onto the system for one foldered kind, as a minimal diff
 * that PRESERVES existing per-item write capabilities. Folder grants and item grants both
 * default to Read on first tick; the write toggle below the tree is what lifts a specific
 * grant.
 */
export function applyFolderSelection(
  system: System,
  kind: FolderedGrantKind,
  sel: TreeSelection,
  itemLayer: (id: string) => DataLayer,
  opts: ApplyOpts = {},
): System {
  const inFamily = opts.inFamily ?? (() => true);
  const manageFolders = opts.manageFolders ?? true;
  const protectedFolders = new Set((opts.protectedFolders ?? []).map(keyOf));
  const listed = opts.listedItemIds === undefined ? null : new Set(opts.listedItemIds);
  let next = system;

  // ── Folder grants: add newly-selected, remove de-selected — except a protected one,
  //    which the tree never showed and therefore never unticked. ──
  if (manageFolders) {
    const wantFolders = new Set(sel.folderGrants.map(keyOf));
    const haveFolders = folderGrantsOf(system, kind);
    for (const f of sel.folderGrants) {
      if (!haveFolders.some((h) => keyOf(h) === keyOf(f))) next = setFolderGrant(next, kind, f, false);
    }
    for (const h of haveFolders) {
      if (wantFolders.has(keyOf(h))) continue;
      if (protectedFolders.has(keyOf(h))) continue; // out of domain: kept, warned about in the UI
      next = removeFolderGrant(next, kind, h);
    }
  }

  // ── Item grants (all foldered kinds, INCLUDING files — a single file can be granted by
  //    its id, exactly like a dataset or a knowledge entry). ──
  {
    const wantItems = new Set(sel.itemGrants.filter(inFamily));
    const haveItems = next.grants[kind].filter((g) => !g.folder && g.id && inFamily(g.id)).map((g) => g.id);
    for (const id of wantItems) {
      if (!haveItems.includes(id)) next = setArtifactGrant(next, kind, id, false, itemLayer(id));
    }
    for (const id of haveItems) {
      if (wantItems.has(id)) continue;
      // Only an id the feed actually LISTED can have been unticked. One it never showed
      // (another domain's artifact, or one that has since been archived) is left alone.
      if (listed === null || !listed.has(id)) continue;
      next = removeArtifactGrant(next, kind, id);
    }
  }
  return next;
}
