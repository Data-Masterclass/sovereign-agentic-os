/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Folders module entry — the governed folder registry and its lifecycle in one import
 * USER STORY: As a developer of a foldered tab I want one import for folder rows and folder
 *             lifecycle actions so that every tab uses the same governed code.
 * ARCHITECTURE:
 *   - Re-exports `folder-store.ts` (rows) and `folder-lifecycle.ts` (row operation plus item cascade).
 *   - Builds on the pure tree helpers in `@core/kernel/folders`; may import `@core/infra` (mirror)
 *     and `@core/policy` (edit-scope). The kernel never imports this module.
 */
export {
  type FolderNode,
  type FolderTab,
  type FolderScope,
  type Principal,
  FolderError,
  ensureHydrated,
  listFolders,
  getFolder,
  folderAndDescendants,
  createFolder,
  renameFolder,
  archiveFolderRows,
  restoreFolderRows,
  deleteFolderRows,
  __resetStore,
} from '@core/folders/folder-store';

// The lifecycle orchestrator — the folder-row op + the member-item cascade, one place.
export {
  moveFolder,
  archiveFolder,
  restoreFolder,
  deleteFolder,
} from '@core/folders/folder-lifecycle';
