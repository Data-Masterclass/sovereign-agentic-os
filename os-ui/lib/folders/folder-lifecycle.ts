/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import {
  getArtifactAdapter,
  type ArtifactAdapter,
  type AdapterPrincipal,
  type AdapterScope,
} from '../core/artifact-adapter.ts';
import { renamePrefix } from '../core/folders.ts';
import {
  type FolderNode,
  type Principal,
  FolderError,
  getFolder,
  renameFolder,
  archiveFolderRows,
  restoreFolderRows,
  deleteFolderRows,
} from './folder-store.ts';

/**
 * THE FOLDER LIFECYCLE ORCHESTRATOR — the ONE place the folder-ROW op is combined
 * with a CASCADE over the member ITEMS (files/datasets/knowledge/metrics) through the
 * shared `ArtifactAdapter`. Written once here so every tab's `/api/<tab>/folders/*`
 * behaves identically and can never drift.
 *
 * Every member cascade is PER-ITEM PERMISSION-CHECKED: each `adapter.*Item` runs the
 * tab's own edit-scope gate and throws (`.status === 403`) when the caller may not act.
 * This orchestrator is FAIL-CLOSED — it does NOT catch those throws, so a single denied
 * member aborts the whole op and surfaces the 403; a cascade can never silently skip
 * governance. (Folder-row ops that already ran before a member throw remain applied;
 * because the row gate and the item gate share `canManageArtifact`, a caller who passed
 * the folder gate almost always passes every member gate, so a mid-cascade 403 is the
 * rare cross-owner edge — and failing loud there is the correct, honest behaviour.)
 *
 * LAYERING: `lib/folders` may import `lib/core` (the adapter registry + tree algebra)
 * and its own store; it is never imported BY `lib/core`.
 */

/** Resolve the adapter for a tab or fail with a clear 500 (a tab that wired folders
 *  but forgot to register its adapter — a bug, surfaced honestly). */
function adapterFor(tab: string): ArtifactAdapter {
  const a = getArtifactAdapter(tab);
  if (!a) throw new FolderError(`No folder adapter registered for '${tab}'`, 500);
  return a;
}

/** The (owner/domain) lane a folder row lives in, as the adapter's scope. */
function scopeOf(node: FolderNode): AdapterScope {
  return node.scope;
}

function principal(user: Principal): AdapterPrincipal {
  return { id: user.id, role: user.role, domains: user.domains };
}

/**
 * MOVE a folder to `destPath`: rename/move the folder ROW + its descendant rows
 * (`renameFolder`) AND rewrite every MEMBER item's folder path through the adapter —
 * closing the Wave-2 gap where `renameFolder` moved only the rows, leaving the items
 * behind. Edit-scoped on both halves. Returns the moved root row.
 */
export function moveFolder(user: Principal, tab: string, id: string, destPath: string): FolderNode {
  const adapter = adapterFor(tab);
  const node = getFolder(id);
  if (!node) throw new FolderError('Folder not found', 404);
  const from = node.path;

  // Snapshot the member items BEFORE the row rename (paths still reference `from`).
  const members = adapter.itemsUnderFolder(principal(user), scopeOf(node), from);

  // Row half (edit-scoped; rewrites this row + descendant rows).
  const moved = renameFolder(user, id, destPath);
  const to = moved.path;

  // Item half — rewrite each member's path by the same prefix rule (fail-closed).
  for (const item of members) {
    const next = renamePrefix(item.folder, from, to);
    if (next === item.folder) continue;
    adapter.moveItem(item.id, principal(user), next);
  }
  return moved;
}

/**
 * ARCHIVE a folder: archive the folder ROW + descendant rows AND every member item
 * under them (adapter.archiveItem). Reversible. Edit-scoped + fail-closed cascade.
 */
export function archiveFolder(user: Principal, tab: string, id: string): FolderNode[] {
  const adapter = adapterFor(tab);
  const node = getFolder(id);
  if (!node) throw new FolderError('Folder not found', 404);
  const members = adapter.itemsUnderFolder(principal(user), scopeOf(node), node.path);
  const rows = archiveFolderRows(user, id);
  for (const item of members) adapter.archiveItem(item.id, principal(user));
  return rows;
}

/** RESTORE an archived folder + its rows AND every member item under it. */
export function restoreFolder(user: Principal, tab: string, id: string): FolderNode[] {
  const adapter = adapterFor(tab);
  const node = getFolder(id);
  if (!node) throw new FolderError('Folder not found', 404);
  // Member items were archived by path at archive time; the rows still carry the path.
  const members = adapter.itemsUnderFolder(principal(user), scopeOf(node), node.path);
  const rows = restoreFolderRows(user, id);
  for (const item of members) adapter.restoreItem(item.id, principal(user));
  return rows;
}

/**
 * PHYSICALLY delete a folder — permanent, ARCHIVED-ONLY (enforced by `deleteFolderRows`).
 * Removes the folder rows AND permanently deletes every member item under them
 * (adapter.deleteItem). Edit-scoped + fail-closed cascade.
 */
export function deleteFolder(user: Principal, tab: string, id: string): { deleted: string[] } {
  const adapter = adapterFor(tab);
  const node = getFolder(id);
  if (!node) throw new FolderError('Folder not found', 404);
  if (!node.archived) {
    throw new FolderError('Archive this folder before deleting it permanently', 409);
  }
  const members = adapter.itemsUnderFolder(principal(user), scopeOf(node), node.path);
  // Delete member items first (each edit-scoped); then remove the rows.
  for (const item of members) adapter.deleteItem(item.id, principal(user));
  const deleted = deleteFolderRows(user, id);
  return { deleted };
}
