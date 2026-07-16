/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Build the folder-node list the agent grant picker's checkbox tree renders, by
 * UNIONING two sources so the tree is never blank when items sit in a folder:
 *
 *   1. EXPLICIT registry rows — the governed `listFolders(viewer, tab, scope)` folders
 *      (incl. EMPTY folders), the same rows the tabs show.
 *   2. IMPLICIT folders synthesized from each grantable item's own `folder` path (and
 *      every ancestor along it). Files use an implicit-rail model — a file's folder
 *      often exists ONLY as a path on the file, with no registry row — so without this
 *      the Files grant section rendered BLANK. Data/Knowledge get the same union for
 *      consistency; explicit rows they already have are simply deduped.
 *
 * Each synthesized node inherits ITS ITEM's scope (personal/domain); the root `'/'` is
 * implicit and never a node; marketplace items contribute no tree node (the picker only
 * trees My/Domain). PURE + client-safe so it is unit-testable directly and the route is
 * a thin wrapper.
 */
import { normaliseFolderPath, pathSegments } from '../core/folders.ts';

export type GrantFolderScope = 'personal' | 'domain';
export type GrantFolderNode = { path: string; scope: GrantFolderScope };

/** The two inputs, minimal: explicit rows carry a path+scope; items carry a folder+scope. */
type ExplicitRow = { path: string; scope: GrantFolderScope };
type FolderedItem = { folder?: string; scope: 'personal' | 'domain' | 'marketplace' };

export function grantFolderNodes(
  explicit: ExplicitRow[],
  items: FolderedItem[],
): GrantFolderNode[] {
  const seen = new Set<string>(); // dedup on `scope\0path`
  const out: GrantFolderNode[] = [];
  const add = (path: string, scope: GrantFolderScope) => {
    const p = normaliseFolderPath(path);
    if (p === '/') return; // the root is implicit, never a node
    const key = `${scope}\0${p}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ path: p, scope });
  };
  // 1) Explicit registry rows.
  for (const r of explicit) add(r.path, r.scope);
  // 2) Implicit folders from item paths — every ancestor segment along the path.
  for (const it of items) {
    if (it.folder === undefined) continue;
    const scope = it.scope === 'domain' ? 'domain' : it.scope === 'personal' ? 'personal' : null;
    if (!scope) continue;
    const segs = pathSegments(it.folder);
    for (let i = 1; i <= segs.length; i += 1) add('/' + segs.slice(0, i).join('/'), scope);
  }
  return out;
}
