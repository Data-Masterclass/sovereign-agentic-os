/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * The latest known files per app, so the security scan + diff see what was
 * actually committed when Forgejo is unreachable (offline). Lives in its OWN
 * module (not server.ts) so BOTH the pipeline commit step (server.ts) and the
 * code-editor save path (apps.ts `saveAppFile`) can update it without an import
 * cycle — an editor save that skipped the snapshot was invisible to the deploy
 * security scan.
 *
 * The implementation now lives in `./file-mirror.ts`, which backs the fast
 * in-process snapshot with a DURABLE OpenSearch mirror so a pod restart no longer
 * loses the tree (a lost repo is fully recoverable). This module re-exports the
 * stable surface (`snapshotFiles` / `getSnapshot`) so every existing importer is
 * unchanged; readers at an async boundary additionally `await hydrateSnapshot`.
 */
export { snapshotFiles, getSnapshot, hydrateSnapshot, deleteSnapshot } from './file-mirror.ts';
