/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Folder registry — the durable, governed store of folder rows for every foldered tab
 * USER STORY: As a user I want folders that I can rename, move, share to my domain and archive so
 *             that I can organise my artifacts the same way in every tab.
 * ARCHITECTURE:
 *   - Authoritative in-process Map plus a best-effort OpenSearch mirror (`os-folders`) and an
 *     append-only version log per row. No `server-only` or Next imports, so it is unit-testable;
 *     the API routes authenticate and scope callers.
 *   - Every mutation is checked by `canManageArtifact` (`@core/policy/edit-scope`) before any write:
 *     personal folders are owner-only; domain folders allow the owner, an in-domain domain_admin
 *     or an admin. Creating a domain folder needs domain_admin or admin.
 *   - Archive is reversible; physical delete only works on an archived folder. This store owns only
 *     the rows; the item cascade lives in `folder-lifecycle.ts`.
 */
import type { Role } from '@core/kernel/session';
import {
  normaliseFolderPath,
  folderName,
  renamePrefix,
} from '@core/kernel/folders';
import { canManageArtifact, type ArtifactScope } from '@core/policy/edit-scope';
import { osMirror } from '@core/infra/os-mirror';
import { mirrorRefresher, newMirrorRefresh, type MirrorRefreshState } from '@core/infra/mirror-refresh';
import { versionLog } from '@core/kernel/versioning';

export type FolderTab =
  | 'files'
  | 'knowledge'
  | 'data'
  | 'metrics'
  // Wave-2 parity rollout: every artifact tab is foldered under the same registry.
  | 'dashboards'
  | 'agents'
  | 'software'
  | 'connections'
  | 'workflows';

export type FolderScope = 'personal' | 'domain';

/** The acting principal — the id/role/domains the edit-scope gate reads. */
export type Principal = { id: string; role: Role; domains: string[] };

export type FolderNode = {
  /** `fld_<rand>` — stable folder id. */
  id: string;
  tab: FolderTab;
  scope: FolderScope;
  owner: string;
  domain: string;
  /** Normalised folder path (leading slash; `'/'` = root). */
  path: string;
  /** Display name — the path's last segment. */
  name: string;
  createdAt: string;
  updatedAt: string;
  /** Soft-archived: hidden from the working rail, reversible, retained. Absent/false = live. */
  archived?: boolean;
  /** When the folder was last archived (ISO). */
  archivedAt?: string;
};

export class FolderError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'FolderError';
    this.status = status;
  }
}

// ------------------------------------------------------------------ state --

type FoldersState = {
  store: Map<string, FolderNode>;
  hydration: Promise<void> | null;
  /** Re-reading the rows another process wrote (`core/infra/mirror-refresh.ts`): the run worker
   *  creates folder rows when an agent saves an output, and os-ui must list them without a restart. */
  refresh: MirrorRefreshState;
};
const FOLDERS_KEY = Symbol.for('soa.folders.store');
function st(): FoldersState {
  const g = globalThis as unknown as Record<symbol, FoldersState | undefined>;
  if (!g[FOLDERS_KEY]) g[FOLDERS_KEY] = { store: new Map(), hydration: null, refresh: newMirrorRefresh() };
  return g[FOLDERS_KEY]!;
}

const mirror = osMirror({
  index: 'os-folders',
  createBody: {
    mappings: {
      properties: {
        id: { type: 'keyword' },
        tab: { type: 'keyword' },
        scope: { type: 'keyword' },
        owner: { type: 'keyword' },
        domain: { type: 'keyword' },
        path: { type: 'keyword' },
        name: { type: 'keyword' },
        createdAt: { type: 'date' },
        updatedAt: { type: 'date' },
        archived: { type: 'boolean' },
        archivedAt: { type: 'date' },
      },
    },
  },
});

const versions = versionLog('folder');

async function hydrate(): Promise<void> {
  const s = st();
  const docs = (await mirror.hydrate(2000)) ?? [];
  refresher.noteHydrated((docs as FolderNode[]).filter((n) => n && n.id).map((n) => n.id));
  for (const n of docs as FolderNode[]) {
    if (n && n.id && !s.store.has(n.id)) s.store.set(n.id, n);
  }
}

/** The shared refresh (`core/infra/mirror-refresh.ts`) applied to the folder rows. */
const refresher = mirrorRefresher<FolderNode>(mirror, () => st().refresh, {
  label: 'folders',
  size: 2000,
  held: (id) => st().store.get(id),
  put: (n) => { st().store.set(n.id, n); },
  drop: (id) => st().store.delete(id),
});

/** Declare THIS process a reader of the folder rows other processes write (worker: 'full',
 *  web app: 'changes'). Called at boot by `worker/agent-runs.ts` and `instrumentation.ts`. */
export function enableMirrorRefresh(on = true): boolean {
  return refresher.enable(on);
}

export async function ensureHydrated(): Promise<void> {
  const s = st();
  if (!s.hydration) s.hydration = Promise.all([hydrate(), versions.ensureHydrated()]).then(() => {});
  await s.hydration;
  await refresher.beforeRead(); // pick up rows another process wrote (no-op unless enabled)
}

/** Test hook: forget every folder + version, reset the mirror probe. */
export function __resetStore(): void {
  const s = st();
  s.store.clear();
  s.hydration = null;
  s.refresh = newMirrorRefresh();
  mirror.__reset();
  versions.__reset();
}

// ------------------------------------------------------------- internals --

function now(): string {
  return new Date().toISOString();
}

function newId(): string {
  return `fld_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;
}

function persist(node: FolderNode): void {
  mirror.writeThrough(node.id, node);
}

/** The edit-scope arg the shared gate reads for a folder. A PERSONAL folder is
 *  owner-only — no admin AND no domain_admin may touch another user's private tree
 *  (the 'personal' scope closes the platform-admin gap too). A DOMAIN folder is a
 *  shared artifact: its owner, an in-domain domain_admin, or a platform admin. */
function gateArt(node: Pick<FolderNode, 'owner' | 'domain' | 'scope'>): { owner: string; domain: string; scope: ArtifactScope } {
  if (node.scope === 'domain') return { owner: node.owner, domain: node.domain, scope: 'shared' };
  return { owner: node.owner, domain: node.domain, scope: 'personal' };
}

function requireManage(user: Principal, node: Pick<FolderNode, 'owner' | 'domain' | 'scope'>): void {
  if (!canManageArtifact(user, gateArt(node))) {
    throw new FolderError('You do not have permission to manage this folder', 403);
  }
}

function findByPath(tab: FolderTab, scope: FolderScope, domain: string, owner: string, path: string): FolderNode | undefined {
  const p = normaliseFolderPath(path);
  for (const n of st().store.values()) {
    if (n.tab !== tab || n.scope !== scope || n.path !== p) continue;
    // Personal folders are keyed by (owner, domain) so same-named folders in
    // different domains are distinct rows. Domain folders are keyed by domain.
    if (scope === 'personal' ? (n.owner === owner && n.domain === domain) : n.domain === domain) return n;
  }
  return undefined;
}

// ----------------------------------------------------------------- reads --

/** Every folder the viewer may see in a `tab` for a `scope`. Personal → the
 *  viewer's own folders, further narrowed to `activeDomain` when non-null; domain
 *  → the folders shared to any of the viewer's domains (also narrowed when an
 *  active domain is set). Archived folders are hidden by default (opt in via
 *  `includeArchived`). Sorted by path for a stable rail order.
 *
 *  `activeDomain` mirrors the OS-wide domain switcher: null / undefined means
 *  "All domains" and shows every folder the viewer owns (same behaviour as the
 *  artifact lists on the "All" selector). A non-null value restricts the listing
 *  to folders stamped with that domain — so switching domains diverges the tree. */
export function listFolders(
  viewer: Principal,
  tab: FolderTab,
  scope: FolderScope,
  opts: { includeArchived?: boolean; activeDomain?: string | null } = {},
): FolderNode[] {
  const activeDomain = opts.activeDomain ?? null;
  const out: FolderNode[] = [];
  for (const n of st().store.values()) {
    if (n.tab !== tab || n.scope !== scope) continue;
    if (n.archived && !opts.includeArchived) continue;
    if (scope === 'personal') {
      if (n.owner !== viewer.id) continue;
      // When an active domain is chosen, only show folders stamped with it.
      if (activeDomain !== null && n.domain !== activeDomain) continue;
      out.push(n);
    } else {
      if (!viewer.domains.includes(n.domain)) continue;
      if (activeDomain !== null && n.domain !== activeDomain) continue;
      out.push(n);
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Every folder row (tab+scope+lane peers) that IS `node` or a descendant of it.
 *  The lane is personal (owner+domain-keyed) or domain (domain-keyed), mirroring how
 *  the rest of the store scopes. Used by the archive/restore/delete row cascade + the
 *  lifecycle orchestrator's member-item cascade. Personal lanes are keyed by
 *  (owner, domain) so same-named folders in different domains stay distinct. */
export function folderAndDescendants(node: FolderNode): FolderNode[] {
  const out: FolderNode[] = [];
  for (const n of st().store.values()) {
    if (n.tab !== node.tab || n.scope !== node.scope) continue;
    if (node.scope === 'personal') {
      // Personal: scope within the same (owner, domain) pair so a /work folder in
      // domain A does not cascade into a /work subtree the user owns in domain B.
      if (n.owner !== node.owner || n.domain !== node.domain) continue;
    } else {
      if (n.domain !== node.domain) continue;
    }
    if (n.path === node.path || n.path.startsWith(node.path + '/')) out.push(n);
  }
  return out;
}

// ------------------------------------------------------------- mutations --

/**
 * Create a folder row at `path`. The path is normalised; the root `'/'` is never
 * a row (it is implicit). A domain folder needs a `domain` the caller belongs to.
 * Idempotent-ish: an existing folder at the same (tab, scope, path) is returned
 * unchanged rather than duplicated.
 */
export function createFolder(
  user: Principal,
  input: { tab: FolderTab; scope: FolderScope; path: string; domain?: string },
): FolderNode {
  const path = normaliseFolderPath(input.path);
  if (path === '/') throw new FolderError('The root folder is implicit and cannot be created', 400);

  const scope = input.scope;
  const domain = scope === 'domain' ? (input.domain ?? user.domains[0] ?? '') : (input.domain ?? user.domains[0] ?? '');
  if (scope === 'domain') {
    if (!domain) throw new FolderError('A domain folder needs a domain', 400);
    if (!user.domains.includes(domain)) throw new FolderError('You are not a member of that domain', 403);
    // Creating DOMAIN-level structure is a domain-admin act: only an in-domain
    // domain_admin (membership checked above) or a platform admin may mint a
    // domain folder. A builder/creator proposes to Domain but does not own or
    // create domain structure — fail-closed BEFORE the owner-passes manage gate
    // (which would otherwise wave them through as the row's would-be owner).
    if (user.role !== 'admin' && user.role !== 'domain_admin') {
      throw new FolderError('Creating a domain folder requires a domain admin or a platform admin', 403);
    }
  }

  // Gate BEFORE any write (fail-closed).
  requireManage(user, { owner: user.id, domain, scope });

  const existing = findByPath(input.tab, scope, domain, user.id, path);
  if (existing) return existing;

  const at = now();
  const node: FolderNode = {
    id: newId(),
    tab: input.tab,
    scope,
    owner: user.id,
    domain,
    path,
    name: folderName(path),
    createdAt: at,
    updatedAt: at,
  };
  st().store.set(node.id, node);
  persist(node);
  versions.record(node.id, user.id, node, 'create');
  return node;
}

/** What {@link ensureFolderRow} did: the row exists now (created or already there), there was
 *  nothing to do (the root is implicit), or the governed create was refused — with the status
 *  and the reason, so the caller reports it instead of losing it. */
export type EnsureFolderResult =
  | { state: 'exists'; path: string; folder: FolderNode }
  | { state: 'root'; path: '/' }
  | { state: 'refused'; path: string; status: number; reason: string };

/**
 * THE ONE DOOR for "an item is being placed in this folder — make sure its folder row exists".
 * Every store that writes an item into a folder (a note, a file, a dataset, an agent system's
 * declared output / folder grant) calls this instead of `createFolder` in a try/catch: the rows
 * are what the folder rail lists, and a note saved into a folder that had no row did not show
 * under "My knowledge" at all.
 *
 * Governed exactly like `createFolder` (it IS `createFolder`): a personal row is the caller's
 * own, a domain row needs a domain_admin / admin. A refusal never undoes the item's write — the
 * item is stored, and the rail also derives folders from item paths (`buildTree`'s implied
 * paths) — but it is not swallowed either: it is logged and returned as `refused` with status +
 * reason for the caller to surface. Anything that is not a governed refusal (a bug) is rethrown.
 */
export function ensureFolderRow(
  user: Principal,
  input: { tab: FolderTab; scope: FolderScope; path: string | undefined | null; domain?: string },
): EnsureFolderResult {
  const path = normaliseFolderPath(input.path);
  if (path === '/') return { state: 'root', path: '/' };
  try {
    return { state: 'exists', path, folder: createFolder(user, { tab: input.tab, scope: input.scope, path, domain: input.domain }) };
  } catch (e) {
    if (!(e instanceof FolderError)) throw e;
    console.warn(
      `[folders] could not create the ${input.scope} ${input.tab} folder ${path}` +
        `${input.domain ? ` in ${input.domain}` : ''} for ${user.id}: ${e.message} (${e.status})`,
    );
    return { state: 'refused', path, status: e.status, reason: e.message };
  }
}

/**
 * Rename/move a folder to `toPath`. Rewrites this row AND every descendant folder
 * row's path prefix (the item side — member files/docs — is rewritten in Wave 2).
 * Edit-scoped. Returns the renamed root node.
 */
export function renameFolder(user: Principal, id: string, toPath: string): FolderNode {
  const s = st();
  const node = s.store.get(id);
  if (!node) throw new FolderError('Folder not found', 404);
  requireManage(user, node);

  const to = normaliseFolderPath(toPath);
  if (to === '/') throw new FolderError('Cannot rename a folder to the root', 400);
  const from = node.path;
  if (to === from) return node;

  const at = now();
  // Rewrite this row + every descendant row that shares the `from` prefix, scoped
  // to the same (owner, domain) lane for personal folders (mirrors folderAndDescendants).
  for (const n of s.store.values()) {
    if (n.tab !== node.tab || n.scope !== node.scope) continue;
    if (node.scope === 'personal') {
      if (n.owner !== node.owner || n.domain !== node.domain) continue;
    } else {
      if (n.domain !== node.domain) continue;
    }
    const rewritten = renamePrefix(n.path, from, to);
    if (rewritten === n.path) continue;
    versions.record(n.id, user.id, n, `rename ${n.path} → ${rewritten}`);
    n.path = rewritten;
    n.name = folderName(rewritten);
    n.updatedAt = at;
    persist(n);
  }
  return s.store.get(id)!;
}

/**
 * ARCHIVE a folder ROW + every descendant folder row (reversible soft-hide). Edit-
 * scoped. The MEMBER-ITEM cascade (archiving the files/datasets inside) is
 * orchestrated by `folder-lifecycle.archiveFolder` through the shared adapter — this
 * flips only the folder rows. Returns the archived rows (root first).
 */
export function archiveFolderRows(user: Principal, id: string): FolderNode[] {
  const s = st();
  const node = s.store.get(id);
  if (!node) throw new FolderError('Folder not found', 404);
  requireManage(user, node);
  const at = now();
  const rows = folderAndDescendants(node);
  for (const n of rows) {
    if (n.archived) continue;
    versions.record(n.id, user.id, n, `archive ${n.path}`);
    n.archived = true;
    n.archivedAt = at;
    n.updatedAt = at;
    persist(n);
  }
  return rows;
}

/** RESTORE an archived folder ROW + its descendant rows (reverse of archive). Edit-
 *  scoped. The member-item cascade is orchestrated one layer up. */
export function restoreFolderRows(user: Principal, id: string): FolderNode[] {
  const s = st();
  const node = s.store.get(id);
  if (!node) throw new FolderError('Folder not found', 404);
  requireManage(user, node);
  const at = now();
  const rows = folderAndDescendants(node);
  for (const n of rows) {
    if (!n.archived) continue;
    versions.record(n.id, user.id, n, `restore ${n.path}`);
    n.archived = false;
    delete n.archivedAt;
    n.updatedAt = at;
    persist(n);
  }
  return rows;
}

/**
 * PHYSICALLY delete a folder ROW + its descendant rows — permanent, only allowed on
 * an ALREADY-ARCHIVED folder (the archive→delete discipline every tab shares). Edit-
 * scoped. The member-item physical delete is orchestrated one layer up. Returns the
 * ids of every removed row.
 */
export function deleteFolderRows(user: Principal, id: string): string[] {
  const s = st();
  const node = s.store.get(id);
  if (!node) throw new FolderError('Folder not found', 404);
  requireManage(user, node);
  if (!node.archived) {
    throw new FolderError('Archive this folder before deleting it permanently', 409);
  }
  const rows = folderAndDescendants(node);
  const deleted: string[] = [];
  for (const n of rows) {
    versions.record(n.id, user.id, n, `delete ${n.path}`);
    s.store.delete(n.id);
    mirror.deleteThrough(n.id);
    refresher.noteDeleted(n.id);
    versions.purge(n.id);
    deleted.push(n.id);
  }
  return deleted;
}

/** Read one folder row (no scoping — the API layer authenticates the caller). */
export function getFolder(id: string): FolderNode | undefined {
  return st().store.get(id);
}


// ------------------------------------------------------------------ delete domain (admin) --
/** Delete-domain: every folder of a domain, in every state (`core/kernel/domain-delete.ts`). */
export function listFoldersForDomain(domain: string): FolderNode[] {
  return [...st().store.values()].filter((x) => x.domain === domain);
}

/** Delete-domain: remove one folder for good. Awaits the durable mirror's confirmation first, so
 *  the record is never reported gone while the shared store still holds it. */
export async function purgeFolderForDomainDelete(id: string): Promise<'deleted' | 'absent'> {
  const out = await mirror.deleteConfirmed(id);
  if (!out.ok) throw Object.assign(new Error(`folder ${id}: the store did not confirm the delete (${out.reason})`), { status: 503 });
  st().store.delete(id);
  refresher.noteDeleted(id);
  versions.purge(id);
  return out.result;
}
