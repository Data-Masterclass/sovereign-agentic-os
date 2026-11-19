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

/**
 * `isUnderFolder` for a folder NAME SOMEBODY TYPED OR A MODEL WROTE — the optional `folder`
 * argument of a listing, never a grant. Letter case is ignored, so asking for `/invoices` finds
 * the files in `/Invoices`. Access rules keep using the exact `isUnderFolder`: this only decides
 * which of the rows the caller may already see are shown.
 */
export function isUnderFolderIgnoringCase(folder: string, child: string): boolean {
  return isUnderFolder(normaliseFolderPath(folder).toLowerCase(), normaliseFolderPath(child).toLowerCase());
}

/** The distinct folder paths of `items`, sorted — for telling a caller which folders exist. */
export function distinctFolders(items: { folder?: unknown }[], cap = 40): string[] {
  const seen = new Set<string>();
  for (const i of items) seen.add(normaliseFolderPath(typeof i.folder === 'string' ? i.folder : '/'));
  return [...seen].sort((a, b) => a.localeCompare(b)).slice(0, cap);
}

/** An item that carries a folder path — the only field the tree algebra needs. */
type Foldered = { folder: string };

/** Every item that lives under `path` (that folder OR any subfolder of it). */
export function itemsUnderFolder<T extends Foldered>(path: string, items: T[]): T[] {
  return items.filter((i) => isUnderFolder(path, i.folder));
}

// -------------------------------------------------------------------- tree --

/** A registry folder row — the minimum the tree algebra reads. The store's
 *  richer `FolderNode` (id/tab/scope/owner/…) structurally satisfies this. The
 *  optional `id`/`archived` let the nav rail drive the folder LIFECYCLE (move /
 *  archive / restore / delete) against the registry row; synthesised (implicit)
 *  folders carry no `id`, so those actions are offered only on real rows. */
export type FolderPathNode = { path: string; name?: string; id?: string; archived?: boolean };

/** The two folder roots every foldered tab renders side by side: the caller's own
 *  private tree ("My folders") and the shared domain tree ("Domain folders"). */
export type FolderRootScope = 'personal' | 'domain';

/**
 * Which root SECTIONS the folder rail (and picker) should render for the active
 * My/Domain/Company scope. `requested` comes from the tab's `rootsForScope` mapping;
 * `undefined` means "show both" (backward-compatible default). A root not in the list
 * is fully hidden — header included — so the inactive scope's empty root never shows
 * as a bare "Domain folders" / "My folders" heading. An active-but-empty root still
 * renders (so a user with no folders yet can still create their first one).
 */
export function visibleFolderRoots(requested?: FolderRootScope[]): FolderRootScope[] {
  const want = requested ?? ['personal', 'domain'];
  return (['personal', 'domain'] as FolderRootScope[]).filter((r) => want.includes(r));
}

/**
 * The full path for a RENAME — same parent, new leaf name. Renaming changes only a
 * folder's last segment (its display name); its parent is untouched (that is a MOVE).
 * The name is trimmed + normalised; a blank name returns `null` (a no-op the caller
 * skips). E.g. renameLeafPath('/a/b', 'c') → '/a/c'; renameLeafPath('/b', 'c') → '/c'.
 */
export function renameLeafPath(fromPath: string, newName: string): string | null {
  const name = newName.trim();
  if (!name) return null;
  const parent = parentPath(normaliseFolderPath(fromPath));
  return normaliseFolderPath(parent === '/' ? `/${name}` : `${parent}/${name}`);
}

/** One node of the nested folder tree. `synthetic` marks an intermediate folder
 *  that has NO registry row of its own (an implicit folder derived from a member
 *  item's path) — it still renders so the hierarchy is never broken. */
export type FolderTreeNode = {
  path: string;
  name: string;
  /** True when no registry row exists for this path (implicit / derived). */
  synthetic: boolean;
  /** The registry row id (real folders only) — the handle the lifecycle ops target. */
  id?: string;
  /** Whether the registry row is archived (real folders only). */
  archived?: boolean;
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

  function ensure(path: string, synthetic: boolean, row?: FolderPathNode): FolderTreeNode {
    const p = normaliseFolderPath(path);
    let node = byPath.get(p);
    if (!node) {
      node = { path: p, name: row?.name?.trim() || folderName(p), synthetic, children: [] };
      if (row && !synthetic) { node.id = row.id; node.archived = row.archived; }
      byPath.set(p, node);
      // Walk up so every ancestor exists (synthetic unless later given a row).
      if (p !== '/') ensure(parentPath(p), true);
    } else if (!synthetic) {
      // A real row supersedes a previously-synthesised placeholder.
      node.synthetic = false;
      if (row?.name?.trim()) node.name = row.name.trim();
      if (row) { node.id = row.id; node.archived = row.archived; }
    }
    return node;
  }

  for (const n of nodes) ensure(n.path, false, n);

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

// ------------------------------------------------------- checkbox selection --

/** An item of the checkbox tree: an id, its folder, and the root (My / Domain) it belongs to. */
export type SelectionItem = { id: string; folder: string; scope?: FolderRootScope };
/** A folder as a grant names it: a path inside ONE root. */
export type FolderGrantRef = { path: string; scope: FolderRootScope };
/** What a checkbox tree stores: whole folders (late-bound) plus single items. */
export type FolderSelectionResult = { folderGrants: FolderGrantRef[]; itemGrants: string[] };

/**
 * Reduce the checked item ids of a two-root checkbox tree to the grants a caller stores: a folder
 * whose EVERY item is checked becomes one FOLDER grant (so items added later are covered), the
 * rest are emitted one by one.
 *
 * EACH ROOT IS REDUCED OVER ITS OWN ITEMS AND STAMPED WITH ITS OWN SCOPE. This used to run once,
 * over the items of BOTH roots, and stamp every folder with the root that was clicked: unticking
 * something under "My files" turned a fully ticked Domain folder into a `personal` folder grant
 * (a folder that does not exist in that lane, so the grant matched nothing), and a `/` grant in
 * one lane counted the other lane's items as its own.
 *
 * `rootScopes` are the roots that hold the catch-all `/` grant — because the grant is already
 * there, or because the "All …" row was just ticked. Only those collapse to `/` when every item
 * is checked. Ticking the one folder that happens to hold everything is a grant on THAT folder,
 * not on everything that will ever be filed in the lane.
 *
 * `actingScope` is the root the toggle happened in; it owns items that carry no scope (the
 * historical single-root shape).
 */
export function computeFolderSelection(args: {
  nodes: Partial<Record<FolderRootScope, FolderPathNode[]>>;
  items: SelectionItem[];
  checked: Set<string>;
  actingScope: FolderRootScope;
  rootScopes?: FolderRootScope[];
}): FolderSelectionResult {
  const { items, checked, actingScope } = args;
  const rootScopes = new Set(args.rootScopes ?? []);
  const anyScoped = items.some((i) => i.scope !== undefined);
  const scopes: FolderRootScope[] = anyScoped ? ['personal', 'domain'] : [actingScope];
  const folderGrants: FolderGrantRef[] = [];
  const covered = new Set<string>();

  for (const scope of scopes) {
    const own = items.filter((i) => (i.scope ?? actingScope) === scope);
    if (own.length === 0) continue;

    if (rootScopes.has(scope) && own.every((i) => checked.has(i.id))) {
      folderGrants.push({ path: '/', scope });
      for (const i of own) covered.add(i.id);
      continue;
    }

    // Every folder path that has a row OR holds items; deepest first, so a fully checked deep
    // folder is captured before its (also full) ancestor.
    const paths = new Set<string>();
    for (const n of args.nodes[scope] ?? []) paths.add(normaliseFolderPath(n.path));
    for (const i of own) paths.add(normaliseFolderPath(i.folder));
    paths.delete('/');
    const ordered = [...paths].sort((a, b) => b.split('/').length - a.split('/').length);
    for (const path of ordered) {
      const under = itemsUnderFolder(path, own).map((i) => i.id);
      if (under.length === 0) continue;
      if (!under.every((id) => checked.has(id))) continue;
      if (!under.every((id) => covered.has(id))) folderGrants.push({ path, scope });
      for (const id of under) covered.add(id);
    }
  }

  const seen = new Set<string>();
  const itemGrants: string[] = [];
  for (const i of items) {
    if (!checked.has(i.id) || covered.has(i.id) || seen.has(i.id)) continue;
    seen.add(i.id);
    itemGrants.push(i.id);
  }
  return { folderGrants, itemGrants };
}
