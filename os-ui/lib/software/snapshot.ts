/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { ScaffoldFile } from './model.ts';

/**
 * The latest known files per app, so the security scan + diff see what was
 * actually committed when Forgejo is unreachable (offline). Lives in its OWN
 * module (not server.ts) so BOTH the pipeline commit step (server.ts) and the
 * code-editor save path (apps.ts `saveAppFile`) can update it without an import
 * cycle — an editor save that skipped the snapshot was invisible to the deploy
 * security scan. Pinned to globalThis so separately-bundled Next.js route
 * handlers (editor save vs deploy request) share ONE snapshot per process.
 */
const SNAPSHOT_KEY = Symbol.for('soa.software.repo-snapshot');
function snapshots(): Map<string, ScaffoldFile[]> {
  const g = globalThis as unknown as Record<symbol, Map<string, ScaffoldFile[]> | undefined>;
  if (!g[SNAPSHOT_KEY]) g[SNAPSHOT_KEY] = new Map();
  return g[SNAPSHOT_KEY]!;
}

export function snapshotFiles(appId: string, files: ScaffoldFile[]): void {
  snapshots().set(appId, files);
}
export function getSnapshot(appId: string): ScaffoldFile[] | null {
  return snapshots().get(appId) ?? null;
}
