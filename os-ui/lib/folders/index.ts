/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * The `lib/folders` module — the durable, governed folder registry that sits on
 * top of the pure `lib/core/folders` tree algebra. Unlike `lib/core`, this module
 * MAY import `lib/infra` (the durable mirror) and `lib/governance` (the edit-scope
 * gate); it must never be imported BY `lib/core`.
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
  createFolder,
  renameFolder,
  deleteFolder,
  __resetStore,
} from './folder-store.ts';
