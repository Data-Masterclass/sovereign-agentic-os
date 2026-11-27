/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Folder lifecycle — move, archive, restore and delete a folder together with its items
 * USER STORY: As a user I want a folder action to apply to everything inside the folder so that a
 *             moved or archived folder never leaves its files, datasets or metrics behind.
 * ARCHITECTURE:
 *   - Combines the folder-row operation (`folder-store.ts`) with a cascade over member items through
 *     the tab's `ArtifactAdapter` (`@core/kernel/artifact-adapter`); one copy for every tab.
 *   - Fail-closed: each `adapter.*Item` runs the tab's own edit-scope check and throws 403; this
 *     module does not catch it, so one denied item aborts the operation. Row changes that already
 *     ran stay applied (rare, since row and item checks share `canManageArtifact`).
 *   - Delete is archived-only and deletes items before rows, so a failed delete can be retried.
 *   - Imports `@core/kernel`; the kernel never imports this module. Exported via `index.ts`.
 */
import {
  getArtifactAdapter,
  type ArtifactAdapter,
  type AdapterPrincipal,
  type AdapterScope,
} from '@core/kernel/artifact-adapter';
import { renamePrefix } from '@core/kernel/folders';
import {
  type FolderNode,
  type Principal,
  FolderError,
  getFolder,
  renameFolder,
  archiveFolderRows,
  restoreFolderRows,
  deleteFolderRows,
} from '@core/folders/folder-store';

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
  if (!node) throw new FolderError('Folder not found', 404, 'folders.notFound');
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
  if (!node) throw new FolderError('Folder not found', 404, 'folders.notFound');
  const members = adapter.itemsUnderFolder(principal(user), scopeOf(node), node.path);
  const rows = archiveFolderRows(user, id);
  for (const item of members) adapter.archiveItem(item.id, principal(user));
  return rows;
}

/** RESTORE an archived folder + its rows AND every member item under it. */
export function restoreFolder(user: Principal, tab: string, id: string): FolderNode[] {
  const adapter = adapterFor(tab);
  const node = getFolder(id);
  if (!node) throw new FolderError('Folder not found', 404, 'folders.notFound');
  // Member items were archived by path at archive time; the rows still carry the path.
  const members = adapter.itemsUnderFolder(principal(user), scopeOf(node), node.path);
  const rows = restoreFolderRows(user, id);
  for (const item of members) adapter.restoreItem(item.id, principal(user));
  return rows;
}

/**
 * PHYSICALLY delete a folder — permanent, ARCHIVED-ONLY (enforced by `deleteFolderRows`).
 * Removes the folder rows AND permanently deletes every member item under them
 * (adapter.deleteItem, awaited one by one). Edit-scoped + fail-closed cascade: a member that
 * cannot be deleted (403, or a delete its store did not confirm) stops the cascade BEFORE the
 * rows go, so the folder is still there holding what is left and the delete can be retried.
 */
export async function deleteFolder(user: Principal, tab: string, id: string): Promise<{ deleted: string[] }> {
  const adapter = adapterFor(tab);
  const node = getFolder(id);
  if (!node) throw new FolderError('Folder not found', 404, 'folders.notFound');
  if (!node.archived) {
    throw new FolderError('Archive this folder before deleting it permanently', 409, 'folders.archiveBeforeDelete');
  }
  const members = adapter.itemsUnderFolder(principal(user), scopeOf(node), node.path);
  // Delete member items first (each edit-scoped); then remove the rows.
  for (const item of members) await adapter.deleteItem(item.id, principal(user));
  const deleted = deleteFolderRows(user, id);
  return { deleted };
}
