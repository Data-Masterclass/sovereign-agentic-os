/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * FOLDER tree algebra — the ONE pure primitive every foldered artifact list
 * (Files, Knowledge, Data) shares. Like `lib/core/scopes.ts` this is the BOTTOM
 * layer: it takes already-authz'd inputs and re-slices them for display and for
 * the run-time grant kernel. It computes on plain paths + ids only.
 *
 * CRITICAL LAYERING: `lib/core` is the bottom layer. This module imports NOTHING
 * from `lib/infra`, `lib/governance`, or any tab. The durable folder STORE (the
 * governance-gated, mirror-persisted registry) lives in `lib/folders` and imports
 * these helpers — never the other way round.
 *
 * A folder is just a `path` string, always normalised to a single leading slash
 * with `'/'` as the root (see `normaliseFolderPath` — the canonical definition;
 * Files' `asset-schema.ts` re-exports it in Wave 2). Membership is prefix-based:
 * an item "lives under" a folder when its own folder path is that folder or any
 * descendant of it. There is no separate parent-id graph — the path IS the tree,
 * so implicit folders (a path segment with no registry row of its own) still
 * render because `buildTree` synthesises the intermediate nodes.
 *
 * Pure + client+server safe (no server-only / Next / network imports): a caller
 * on either side gets identical results.
 */

/** Normalise a folder path to a single leading slash, no trailing slash; the
 *  empty/undefined path is the root `'/'`. THE canonical definition — every
 *  folder path in the OS passes through here so equality + prefix checks are
 *  stable (`'contracts/'`, `'/contracts'`, `' contracts '` all → `'/contracts'`). */
export function normaliseFolderPath(path: string | undefined | null): string {
  if (!path) return '/';
  const parts = String(path)
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);
  return '/' + parts.join('/');
}

/** The path segments of a folder (root → leaf), root `'/'` yielding `[]`.
 *  `'/a/b'` → `['a', 'b']`. */
export function pathSegments(path: string): string[] {
  return normaliseFolderPath(path).split('/').filter(Boolean);
}

/** The parent folder path of `path`; the root's parent is the root itself.
 *  `'/a/b'` → `'/a'`, `'/a'` → `'/'`, `'/'` → `'/'`. */
export function parentPath(path: string): string {
  const segs = pathSegments(path);
  if (segs.length === 0) return '/';
  segs.pop();
  return segs.length === 0 ? '/' : '/' + segs.join('/');
}

/** The last segment of a folder path — its display name. Root → `'/'`. */
export function folderName(path: string): string {
  const segs = pathSegments(path);
  return segs.length === 0 ? '/' : segs[segs.length - 1];
}

/**
 * Rewrite a folder path when its ancestor `from` is renamed/moved to `to`. Used
 * by the store on rename to rewrite every descendant member's path prefix. A
 * path that is NOT under `from` (nor equal to it) is returned unchanged, so this
 * is safe to map over a mixed list.
 *
 *   renamePrefix('/a/b/c', '/a/b', '/a/x') → '/a/x/c'
 *   renamePrefix('/a/b',   '/a/b', '/a/x') → '/a/x'
 *   renamePrefix('/other', '/a/b', '/a/x') → '/other'
 */
export function renamePrefix(path: string, from: string, to: string): string {
  const p = normaliseFolderPath(path);
  const f = normaliseFolderPath(from);
  const t = normaliseFolderPath(to);
  if (p === f) return t;
  const prefix = f === '/' ? '/' : f + '/';
  if (!p.startsWith(prefix)) return p;
  const rest = p.slice(prefix.length);
  return t === '/' ? '/' + rest : t + '/' + rest;
}

/** True when `folder` (`path`) contains `child` — i.e. `child` is `folder` or a
 *  descendant of it. Both are normalised first. The root `'/'` contains all. */
export function isUnderFolder(folder: string, child: string): boolean {
  const f = normaliseFolderPath(folder);
  const c = normaliseFolderPath(child);
  if (f === '/') return true;
  return c === f || c.startsWith(f + '/');
}

/** An item that carries a folder path — the only field the tree algebra needs. */
type Foldered = { folder: string };

/** Every item that lives under `path` (that folder OR any subfolder of it). */
export function itemsUnderFolder<T extends Foldered>(path: string, items: T[]): T[] {
  return items.filter((i) => isUnderFolder(path, i.folder));
}

// -------------------------------------------------------------------- tree --

/** A registry folder row — the minimum the tree algebra reads. The store's
 *  richer `FolderNode` (id/tab/scope/owner/…) structurally satisfies this. */
export type FolderPathNode = { path: string; name?: string };

/** One node of the nested folder tree. `synthetic` marks an intermediate folder
 *  that has NO registry row of its own (an implicit folder derived from a member
 *  item's path) — it still renders so the hierarchy is never broken. */
export type FolderTreeNode = {
  path: string;
  name: string;
  /** True when no registry row exists for this path (implicit / derived). */
  synthetic: boolean;
  children: FolderTreeNode[];
};

/**
 * Build the nested folder tree from a flat list of registry folder rows.
 * Intermediate path segments that lack a row are SYNTHESISED (so `'/a/b/c'`
 * with only a `'/a/b/c'` row still yields `a → b → c`). Children are sorted by
 * name (case-insensitive). The returned array is the ROOT's children (the root
 * `'/'` itself is implicit and not represented as a node).
 */
export function buildTree(nodes: FolderPathNode[]): FolderTreeNode[] {
  // Map every path (and each of its ancestors) to a node, synthesising as we go.
  const byPath = new Map<string, FolderTreeNode>();

  function ensure(path: string, synthetic: boolean, name?: string): FolderTreeNode {
    const p = normaliseFolderPath(path);
    let node = byPath.get(p);
    if (!node) {
      node = { path: p, name: name?.trim() || folderName(p), synthetic, children: [] };
      byPath.set(p, node);
      // Walk up so every ancestor exists (synthetic unless later given a row).
      if (p !== '/') ensure(parentPath(p), true);
    } else if (!synthetic) {
      // A real row supersedes a previously-synthesised placeholder.
      node.synthetic = false;
      if (name?.trim()) node.name = name.trim();
    }
    return node;
  }

  for (const n of nodes) ensure(n.path, false, n.name);

  // Link children to parents (skip the implicit root).
  const roots: FolderTreeNode[] = [];
  for (const node of byPath.values()) {
    if (node.path === '/') continue;
    const parent = parentPath(node.path);
    if (parent === '/') roots.push(node);
    else byPath.get(parent)?.children.push(node);
  }

  const byName = (a: FolderTreeNode, b: FolderTreeNode) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  const sortDeep = (list: FolderTreeNode[]) => {
    list.sort(byName);
    for (const c of list) sortDeep(c.children);
  };
  sortDeep(roots);
  return roots;
}

// ------------------------------------------------------------ grant kernel --

/** An item that carries an id + a folder path — what the grant kernel resolves. */
type FolderedItem = { id: string; folder: string };

/**
 * THE RUN-TIME FOLDER-GRANT KERNEL. Resolve a folder grant to the concrete item
 * ids it currently covers. `scopedItems` MUST be a list the caller has ALREADY
 * DLS-scoped for the acting principal, so the result can only ever be a SUBSET
 * of what the caller may see — a folder grant can never widen access, and newly
 * added items under the folder are covered automatically next resolution.
 *
 * Returns the ids of every scoped item living under `folderPath` (incl.
 * subfolders), de-duplicated and stable-ordered by first appearance.
 */
export function resolveFolderGrant<T extends FolderedItem>(
  folderPath: string,
  scopedItems: T[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of itemsUnderFolder(folderPath, scopedItems)) {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      out.push(item.id);
    }
  }
  return out;
}

/** A folder's checkbox state relative to a set of already-checked item ids. */
export type TriState = 'none' | 'some' | 'all';

/**
 * The tri-state of a folder's checkbox: `none` (no item under it is checked),
 * `all` (every item under it is checked), or `some` (a mix → the indeterminate
 * dash). `allUnder` are the ids of every item under the folder (the caller passes
 * the already-scoped universe); `checkedIds` is the current selection. An empty
 * folder is `none`.
 */
export function triState(
  _folderPath: string,
  checkedIds: Iterable<string>,
  allUnder: string[],
): TriState {
  if (allUnder.length === 0) return 'none';
  const checked = checkedIds instanceof Set ? checkedIds : new Set(checkedIds);
  let hits = 0;
  for (const id of allUnder) if (checked.has(id)) hits++;
  if (hits === 0) return 'none';
  return hits === allUnder.length ? 'all' : 'some';
}
