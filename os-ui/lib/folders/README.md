<!-- SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG -->

# `lib/folders` — governed folder registry

## Purpose

The durable, governed folder store for the OS-wide folder primitive. Folders are first-class rows (not implicit path strings on items) so they can be renamed, moved, shared to a domain, and granted to an agent. This module owns the folder rows and the lifecycle cascade over their member items.

It sits one layer above `lib/core/folders` (the pure tree algebra) and may import `lib/infra` (the OpenSearch mirror) and `lib/governance` (the edit-scope gate). It must never be imported by `lib/core`.

Applies to the four context tabs: **Files · Data · Knowledge · Metrics** (`FolderTab`).

## Public API surface

**From `folder-store.ts`:** `FolderNode`, `FolderTab`, `FolderScope`, `Principal`, `FolderError`, `ensureHydrated`, `listFolders`, `getFolder`, `folderAndDescendants`, `createFolder`, `renameFolder`, `archiveFolderRows`, `restoreFolderRows`, `deleteFolderRows`, `__resetStore`.

**From `folder-lifecycle.ts`:** `moveFolder`, `archiveFolder`, `restoreFolder`, `deleteFolder`.

The lifecycle functions (`archiveFolder`, `restoreFolder`, `deleteFolder`) are the ones to call from API routes — they combine the folder-row op with a per-item cascade through the `ArtifactAdapter` registry. The `*Rows` variants in the store are the row-only half and are called by the orchestrator, not directly from routes.

## Invariants

- **Governance is fail-closed.** Every mutation is gated by `canManageArtifact` (owner, in-domain `domain_admin`, or platform `admin`). A caller who fails the gate gets a 403 and nothing is written.
- **Lifecycle is archive → restore → physical delete only.** Physical delete is allowed only on an already-archived folder. A cascade that encounters a permission denial aborts loudly — it does not silently skip items.
- **Folders survive redeploys.** The authoritative store is an in-process `Map` backed by a best-effort OpenSearch mirror (`os-folders`). `ensureHydrated` rehydrates from the mirror on startup.
- **No `server-only` / Next imports.** The store is unit-testable directly; API routes are the server boundary for auth + scoping.
- **Scopes are `personal | domain`.** A personal folder is owner-only; a domain folder is manageable by domain admins of its domain. Folder paths are normalised (leading slash; `'/'` = root).
