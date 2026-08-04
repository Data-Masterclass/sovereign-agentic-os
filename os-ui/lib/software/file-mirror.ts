/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { config } from '../core/config.ts';
import { osMirror } from '../infra/os-mirror.ts';
import type { ScaffoldFile } from './model.ts';

/**
 * DURABLE app-source mirror — the fix for the single-point-of-failure that lost
 * two built stories live (northpeak-products). The app RECORD (os-apps) stores
 * file NAMES only; the FULL committed tree (path + content) lived ONLY in an
 * in-process `globalThis` snapshot that dies on every pod restart AND in Forgejo.
 * A lost repo therefore meant unrecoverable source.
 *
 * This module keeps that fast in-process snapshot as the authoritative,
 * SYNCHRONOUS read (so `getSnapshot` callers — incl. the diff/changeset routes —
 * are unchanged) and adds a best-effort OpenSearch mirror behind it:
 *
 *   • `snapshotFiles(appId, files)` — sets the in-process Map AND fire-and-forget
 *     write-throughs the whole tree to `os-app-files` (one doc per app). Every
 *     call site is a VERIFIED-real tree: `commitToApp` after its honesty gate, an
 *     editor save after a confirmed Forgejo PUT, or a successful LIVE repo read.
 *     A rejected commit never reaches here, so the mirror never persists a
 *     phantom (respects the 0.6.54 honest-commit contract).
 *   • `getSnapshot(appId)` — synchronous Map read, signature unchanged.
 *   • `hydrateSnapshot(appId)` — async; on a cold-process Map MISS, pulls the tree
 *     from the mirror and repopulates the Map so the following synchronous
 *     `getSnapshot` succeeds. This is what makes the offline tree, before/after
 *     changesets and repo-heal SURVIVE a restart.
 *
 * STORAGE SHAPE — one doc per app keyed by appId: `{ appId, files, updatedAt }`.
 * An app tree is text source, a few hundred KB at most — far under OpenSearch's
 * default 100MB `http.max_content_length`, so a single doc per app is safe and
 * gives an atomic whole-tree replace (matching the snapshot's replace semantics)
 * with no orphan-doc reconciliation. Everything degrades gracefully: an
 * unreachable OpenSearch never throws into a request; the store stays in-memory.
 * Kept free of `server-only`/Next imports so it is directly unit-testable.
 */

type FileDoc = { appId: string; files: ScaffoldFile[]; updatedAt: string };

const mirror = osMirror({ index: config.appFilesIndex });

const SNAPSHOT_KEY = Symbol.for('soa.software.repo-snapshot');
function snapshots(): Map<string, ScaffoldFile[]> {
  const g = globalThis as unknown as Record<symbol, Map<string, ScaffoldFile[]> | undefined>;
  if (!g[SNAPSHOT_KEY]) g[SNAPSHOT_KEY] = new Map();
  return g[SNAPSHOT_KEY]!;
}

/** Set the in-process tree AND durably write it through (fire-and-forget). */
export function snapshotFiles(appId: string, files: ScaffoldFile[]): void {
  snapshots().set(appId, files);
  const doc: FileDoc = { appId, files, updatedAt: new Date().toISOString() };
  mirror.writeThrough(appId, doc);
}

/** Synchronous in-process read. Null ⇒ this process has no cached tree (a cold
 *  process, or an app never touched here) — call `hydrateSnapshot` first to pull
 *  the durable mirror into the Map when an async boundary allows. */
export function getSnapshot(appId: string): ScaffoldFile[] | null {
  return snapshots().get(appId) ?? null;
}

/**
 * On a cold-process Map MISS, hydrate the tree from the durable mirror and cache
 * it, so the subsequent synchronous `getSnapshot(appId)` returns the FULL tree a
 * previous process committed. Returns the files (mirror-hit), the already-cached
 * files (Map-hit, no fetch), or null (nothing anywhere / mirror unreachable).
 * NEVER throws — a down mirror just yields null and the caller degrades honestly.
 */
export async function hydrateSnapshot(appId: string): Promise<ScaffoldFile[] | null> {
  const cached = snapshots().get(appId);
  if (cached) return cached;
  const doc = (await mirror.getDoc(appId)) as FileDoc | null;
  const files = doc?.files;
  if (!Array.isArray(files) || files.length === 0) return null;
  snapshots().set(appId, files);
  return files;
}

/** Drop the durable mirror doc (on app delete). In-process Map is left alone; the
 *  caller owns process-local lifecycle. */
export function deleteSnapshot(appId: string): void {
  mirror.deleteThrough(appId);
}

/** Test seam: forget in-process snapshots + mirror probe state (fresh process). */
export function __resetSnapshots(): void {
  snapshots().clear();
  mirror.__reset();
}
