/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       agents
 * FEATURE:    Turn a folder-tree selection into grant edits WITHOUT deleting what the tree cannot see
 * USER STORY: As an author I tick a folder in my team's domain and every other grant the team
 *             already holds is still there afterwards.
 * ARCHITECTURE:
 *   - Lifted out of `GrantPickers.tsx` so the round trip is unit-testable: a test cannot import
 *     a `.tsx` (Node strips types but not JSX). The component now only wires it.
 *   - The reconcile is a DIFF against what the tree could actually show, not against the whole
 *     system. That distinction is the fix for a real defect: once the grant feed is narrowed to
 *     the system's domain, a folder grant pointing elsewhere has no items in the feed —
 *     `triState` calls an item-less folder 'none' and `computeSelection` skips it — so the
 *     emitted selection omits it. Reading that omission as "the user unticked it" DELETED a live
 *     grant on the first tick. The same held for an item grant whose id the feed stopped listing.
 *   - Hence two inputs that bound removal: `listedItemIds` (what the feed showed) and
 *     `protectedFolders` (nodes deliberately kept OUT of the tree). Pass neither and nothing is
 *     removed — unknown universe ⇒ no destruction, never the other way round.
 *   - Per-item write capabilities are preserved: an id that stays selected is left ALONE rather
 *     than re-set at the Read default.
 *   - THE TREE'S TICKS ARE DERIVED HERE TOO (`checkedIdsFor`), and they are per LANE. They used
 *     to be computed in the component by path alone, so a `/` grant on "My files" ticked every
 *     file under "Domain files" as well: a system that could read nothing showed Domain
 *     `/invoices` as granted, and its owner had no way to see that the grant was in the other
 *     lane. A grant is `{ path, scope }`; a tick must be too.
 *   - A FOLDER GRANT THAT COVERS NO ITEM cannot be drawn from item ticks at all, so the tree can
 *     never emit it — the same "absent ≠ unticked" trap as above. `treeProtectedFolders` keeps
 *     those out of the reconcile (an output folder nothing was written to yet lost its Write
 *     grant on the next unrelated tick); they are granted and removed as folders, explicitly.
 */
import {
  setArtifactGrant, removeArtifactGrant, setFolderGrant, removeFolderGrant,
} from '@tabs/agents/lib/simple-edit';
import { itemsUnderFolder, normaliseFolderPath } from '@core/kernel/folders';
import type { System, DataLayer } from '@tabs/agents/lib/system-schema';

/** The foldered grant kinds the tree edits. */
// `workflows` is listed so the item picker can share the folder-aware code; a workflow has no folders,
// so it is NOT in `FOLDERED_GRANT_KINDS` below and no folder grant is ever made for it.
export type FolderedGrantKind = 'data' | 'knowledge' | 'workflows' | 'files';

/** A folder reference `{path, scope}` — structurally the FolderTree's `FolderGrant`.
 *  Declared here rather than imported so this module pulls in no `.tsx`. */
export type FolderRef = { path: string; scope: 'personal' | 'domain' };

/** What the tree emits — structurally the FolderTree's `FolderSelection`. */
export type TreeSelection = { folderGrants: FolderRef[]; itemGrants: string[] };

export type ApplyOpts = {
  /** When the knowledge feed is split into Workflows vs Knowledge, each picker reconciles
   *  ONLY its own item family so it never removes the other's grants. */
  inFamily?: (id: string) => boolean;
  /** False for the Workflows picker (workflows carry no folders) — folder grants untouched. */
  manageFolders?: boolean;
  /**
   * The item ids the feed could actually show. An existing item grant OUTSIDE this set was
   * never offered to the tree, so its absence from the selection means nothing and it is
   * kept. Omit ⇒ the universe is unknown ⇒ no item grant is removed.
   */
  listedItemIds?: Iterable<string>;
  /**
   * Folder grants the feed flagged as outside the system's domain. They are rendered as
   * read-only chips rather than tree nodes, so the tree can never emit them; they are kept.
   */
  protectedFolders?: FolderRef[];
};

/** The folder grants of a kind currently on the system (each `{path,scope}`). */
export function folderGrantsOf(system: System, kind: FolderedGrantKind): FolderRef[] {
  return system.grants[kind]
    .filter((g) => g.folder)
    .map((g) => ({ path: g.folder!.path, scope: g.folder!.scope }));
}

const keyOf = (f: { path: string; scope: string }) => `${f.scope}:${normaliseFolderPath(f.path)}`;

/**
 * Apply a folder-tree selection onto the system for one foldered kind, as a minimal diff
 * that PRESERVES existing per-item write capabilities. Folder grants and item grants both
 * default to Read on first tick; the write toggle below the tree is what lifts a specific
 * grant.
 */
export function applyFolderSelection(
  system: System,
  kind: FolderedGrantKind,
  sel: TreeSelection,
  itemLayer: (id: string) => DataLayer,
  opts: ApplyOpts = {},
): System {
  const inFamily = opts.inFamily ?? (() => true);
  const manageFolders = opts.manageFolders ?? true;
  const protectedFolders = new Set((opts.protectedFolders ?? []).map(keyOf));
  const listed = opts.listedItemIds === undefined ? null : new Set(opts.listedItemIds);
  let next = system;

  // ── Folder grants: add newly-selected, remove de-selected — except a protected one,
  //    which the tree never showed and therefore never unticked. ──
  if (manageFolders) {
    const wantFolders = new Set(sel.folderGrants.map(keyOf));
    const haveFolders = folderGrantsOf(system, kind);
    for (const f of sel.folderGrants) {
      if (!haveFolders.some((h) => keyOf(h) === keyOf(f))) next = setFolderGrant(next, kind, f, false);
    }
    for (const h of haveFolders) {
      if (wantFolders.has(keyOf(h))) continue;
      if (protectedFolders.has(keyOf(h))) continue; // out of domain: kept, warned about in the UI
      next = removeFolderGrant(next, kind, h);
    }
  }

  // ── Item grants (all foldered kinds, INCLUDING files — a single file can be granted by
  //    its id, exactly like a dataset or a knowledge entry). ──
  {
    const wantItems = new Set(sel.itemGrants.filter(inFamily));
    const haveItems = next.grants[kind].filter((g) => !g.folder && g.id && inFamily(g.id)).map((g) => g.id);
    for (const id of wantItems) {
      if (!haveItems.includes(id)) next = setArtifactGrant(next, kind, id, false, itemLayer(id));
    }
    for (const id of haveItems) {
      if (wantItems.has(id)) continue;
      // Only an id the feed actually LISTED can have been unticked. One it never showed
      // (another domain's artifact, or one that has since been archived) is left alone.
      if (listed === null || !listed.has(id)) continue;
      next = removeArtifactGrant(next, kind, id);
    }
  }
  return next;
}

// ------------------------------------------------- what the tree shows, per lane --

/** A feed item as the tree sees it: its id, folder and LANE (My / Domain). */
export type TreeItemRef = { id: string; folder: string; scope: 'personal' | 'domain' };

const sameFolder = (a: FolderRef, b: FolderRef) => keyOf(a) === keyOf(b);

/** The tree items a folder grant covers: under its path AND in its own lane. */
export function itemsCoveredBy<T extends TreeItemRef>(folder: FolderRef, items: T[]): T[] {
  return itemsUnderFolder(folder.path, items.filter((i) => i.scope === folder.scope));
}

/**
 * The item ids the tree draws as ticked: explicit item grants, plus every tree item a folder
 * grant covers IN THAT GRANT'S LANE.
 */
export function checkedIdsFor(
  system: System,
  kind: FolderedGrantKind,
  treeItems: TreeItemRef[],
  inFamily: (id: string) => boolean = () => true,
): string[] {
  const checked = new Set<string>();
  for (const g of system.grants[kind]) {
    if (g.folder) for (const it of itemsCoveredBy(g.folder, treeItems)) checked.add(it.id);
    else if (g.id && inFamily(g.id)) checked.add(g.id);
  }
  return [...checked];
}

/** The lanes that hold the catch-all `/` folder grant of a kind. */
export function rootGrantedScopes(system: System, kind: FolderedGrantKind): FolderRef['scope'][] {
  const out = new Set<FolderRef['scope']>();
  for (const f of folderGrantsOf(system, kind)) if (normaliseFolderPath(f.path) === '/') out.add(f.scope);
  return [...out];
}

/** Folder grants that cover NO tree item right now (an empty or not-yet-created folder). */
export function emptyFolderGrants(system: System, kind: FolderedGrantKind, treeItems: TreeItemRef[]): FolderRef[] {
  return folderGrantsOf(system, kind).filter((f) => itemsCoveredBy(f, treeItems).length === 0);
}

/**
 * Every folder grant the tree CANNOT express as ticks, and therefore must never remove by
 * omission:
 *   - the ones the feed flagged as outside the system's domain (`outside`);
 *   - the ones that cover no item (nothing to tick);
 *   - a `/` grant on a kind whose tree has no "All …" row (`rootGrantable` false): the tree
 *     emits folders and items there, never `/`, so the first tick would replace a Write grant
 *     on the whole lane with Read grants on what happens to be in it today.
 */
export function treeProtectedFolders(
  system: System,
  kind: FolderedGrantKind,
  treeItems: TreeItemRef[],
  opts: { outside?: FolderRef[]; rootGrantable?: boolean } = {},
): FolderRef[] {
  const out: FolderRef[] = [...(opts.outside ?? []).map((f) => ({ path: f.path, scope: f.scope }))];
  const add = (f: FolderRef) => { if (!out.some((o) => sameFolder(o, f))) out.push(f); };
  for (const f of emptyFolderGrants(system, kind, treeItems)) add(f);
  if (!opts.rootGrantable) {
    for (const f of folderGrantsOf(system, kind)) if (normaliseFolderPath(f.path) === '/') add(f);
  }
  return out;
}

// --------------------------------------------------------- "this grant is empty" --

const LANE_LABEL: Record<FolderRef['scope'], Record<FolderedGrantKind, string>> = {
  personal: { files: 'My files', data: 'My data', knowledge: 'My knowledge', workflows: 'My workflows' },
  domain: { files: 'Domain files', data: 'Domain data', knowledge: 'Domain knowledge', workflows: 'Domain workflows' },
};
const KIND_NOUN: Record<FolderedGrantKind, [string, string]> = {
  files: ['file', 'files'],
  data: ['dataset', 'datasets'],
  knowledge: ['knowledge note', 'knowledge notes'],
  workflows: ['workflow', 'workflows'],
};

/** How a folder grant is named to a person: `/invoices in Domain files`. */
export function describeFolderGrant(kind: FolderedGrantKind, f: FolderRef): string {
  const path = normaliseFolderPath(f.path);
  return path === '/' ? `all of ${LANE_LABEL[f.scope][kind]}` : `${path} in ${LANE_LABEL[f.scope][kind]}`;
}

/** Where the items a zero-match grant was probably meant for actually are. */
export type GrantElsewhere = { path: string; scope: FolderRef['scope']; count: number };

/** One folder grant against the items currently visible: how many it covers, and a pointer if none. */
export type FolderGrantCoverage = { folder: FolderRef; count: number; elsewhere: GrantElsewhere | null };

/**
 * How many of `items` a folder grant covers, and — when it covers NONE — the folder of the same
 * name that does hold items: first the same path in the OTHER lane (My vs Domain), then a folder
 * whose name differs only in letter case (a grant matches its path exactly), same lane first.
 *
 * `items` must already be the list the reader may see (the builder's feed, or the runner's own
 * listing). The pointer is for the PERSON building or running the system. It is never put into
 * an agent's prompt or a tool result: an agent is not told about files outside its grant.
 */
export function folderGrantCoverage(folder: FolderRef, items: TreeItemRef[]): FolderGrantCoverage {
  const path = normaliseFolderPath(folder.path);
  const ref: FolderRef = { path, scope: folder.scope };
  const count = itemsCoveredBy(ref, items).length;
  if (count > 0) return { folder: ref, count, elsewhere: null };

  const other: FolderRef['scope'] = folder.scope === 'personal' ? 'domain' : 'personal';
  const exactOther = itemsCoveredBy({ path, scope: other }, items).length;
  if (exactOther > 0) return { folder: ref, count, elsewhere: { path, scope: other, count: exactOther } };

  // Same name, different letter case — the most specific folder that holds items.
  const lower = path.toLowerCase();
  for (const scope of [folder.scope, other]) {
    const candidates = new Set<string>();
    for (const i of items) {
      if (i.scope !== scope) continue;
      const segs = normaliseFolderPath(i.folder).split('/').filter(Boolean);
      for (let n = 1; n <= segs.length; n += 1) {
        const p = '/' + segs.slice(0, n).join('/');
        if (p !== path && p.toLowerCase() === lower) candidates.add(p);
      }
    }
    for (const p of [...candidates].sort()) {
      const n = itemsCoveredBy({ path: p, scope }, items).length;
      if (n > 0) return { folder: ref, count, elsewhere: { path: p, scope, count: n } };
    }
  }
  return { folder: ref, count, elsewhere: null };
}

/**
 * The warning for a folder grant that covers nothing, or null when it covers something.
 * `subject: 'this'` is the builder's wording at the chip; `'named'` names the grant, for a list
 * of run warnings read away from the control.
 */
export function zeroMatchWarning(
  kind: FolderedGrantKind,
  cov: FolderGrantCoverage,
  subject: 'this' | 'named' = 'this',
): string | null {
  if (cov.count > 0) return null;
  const [one, many] = KIND_NOUN[kind];
  const head = subject === 'this'
    ? `This grant currently contains 0 ${many}.`
    : `The grant on ${describeFolderGrant(kind, cov.folder)} currently contains 0 ${many}.`;
  if (!cov.elsewhere) return head;
  const e = cov.elsewhere;
  const where = normaliseFolderPath(e.path) === '/' ? LANE_LABEL[e.scope][kind] : `${LANE_LABEL[e.scope][kind]} ${e.path}`;
  return `${head} ${e.count} ${e.count === 1 ? `${one} is` : `${many} are`} in ${where}.`;
}

/**
 * The warning for a folder grant that covers MORE items than one run may resolve (the folder-grant
 * budget): only the first `kept` are granted, and the run must say so rather than look complete.
 */
export function cappedGrantWarning(kind: FolderedGrantKind, folder: FolderRef, kept: number, total: number): string {
  const [, many] = KIND_NOUN[kind];
  return `The grant on ${describeFolderGrant(kind, folder)} covers ${total} ${many}; this run was given only the first ${kept} of ${total} ${many} (the folder-grant budget). Narrow the grant to a subfolder, or ask an admin to raise the budget.`;
}

/** True when a folder is where a declared output of this kind is written (empty is expected there). */
export function isOutputFolder(system: System, kind: FolderedGrantKind, f: FolderRef): boolean {
  return (system.outputs ?? []).some(
    (o) => o.kind === kind && o.folder.scope === f.scope && normaliseFolderPath(o.folder.path) === normaliseFolderPath(f.path),
  );
}

/** The foldered kinds a folder grant can be counted for, in the Grant stage's order. */
export const FOLDERED_GRANT_KINDS: FolderedGrantKind[] = ['data', 'knowledge', 'files'];

/** The slice of the `…/grants/available?kind=` feed the zero-match count reads. */
export type GrantFeedSlice = {
  items: { id: string; scope: string; folder?: string }[];
  folders?: { path: string; scope: string; outsideDomain?: boolean }[];
};

/**
 * The ENABLED folder grants of a kind that match no item today, each as the sentence the
 * builder shows ("The grant on … currently contains 0 files. 3 files are in …"). The same
 * rule the picker applies at its chips, as one pure function so the stage rail can use it
 * without the picker being mounted: a grant switched Off/Blocked is not counted, nor an
 * output folder (empty until the first result is written), nor a folder outside the
 * system's domain (this feed cannot count it — unknown is never reported as empty).
 */
export function zeroMatchFolderGrants(system: System, kind: FolderedGrantKind, feed: GrantFeedSlice): string[] {
  const laneItems: TreeItemRef[] = feed.items
    .filter((a) => a.scope === 'personal' || a.scope === 'domain')
    .map((a) => ({ id: a.id, folder: a.folder ?? '/', scope: a.scope as FolderRef['scope'] }));
  const outside = new Set((feed.folders ?? []).filter((f) => f.outsideDomain).map(keyOf));
  const out: string[] = [];
  for (const g of system.grants[kind]) {
    if (!g.folder || g.capability === 'Off' || g.capability === 'Blocked') continue;
    const f: FolderRef = { path: g.folder.path, scope: g.folder.scope };
    if (outside.has(keyOf(f)) || isOutputFolder(system, kind, f)) continue;
    const warning = zeroMatchWarning(kind, folderGrantCoverage(f, laneItems), 'named');
    if (warning) out.push(warning);
  }
  return out;
}
