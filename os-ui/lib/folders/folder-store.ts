/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { Role } from '../core/session.ts';
import {
  normaliseFolderPath,
  folderName,
  renamePrefix,
} from '../core/folders.ts';
import { canManageArtifact, type ArtifactScope } from '../governance/edit-scope.ts';
import { osMirror } from '../infra/os-mirror.ts';
import { versionLog } from '../core/versioning.ts';

/**
 * The FOLDER registry — the durable store behind the OS-wide folder primitive.
 *
 * A folder is a first-class, governed row so it can be renamed, moved, shared to
 * a domain and (Wave 3) granted to an agent — none of which a purely-implicit
 * "folder = a path on some item" model allows. It mirrors the shape of every
 * other OS store: an authoritative in-process Map, a best-effort OpenSearch
 * mirror (`os-folders`) that lets folders survive a redeploy, and an append-only
 * version log per row. Kept free of `server-only` / Next imports so it is
 * unit-testable directly; the API routes are the server boundary that
 * authenticates + scopes callers.
 *
 * GOVERNANCE (fail-closed): every mutation is gated by `canManageArtifact` — the
 * ONE shared edit-scope rule (owner, in-domain `domain_admin`, or platform
 * `admin`). A personal folder is owned by its creator; a domain folder is owned
 * by its creator but manageable by a domain admin of its domain too. A caller
 * who fails the gate gets a 403 and NOTHING is written.
 *
 * LIFECYCLE: folders share the OS-wide archive → restore → (physical) delete
 * discipline. A folder is soft-archived (reversible, retained); a physical delete
 * is only allowed on an already-archived folder. The CASCADE over member items
 * (files/datasets/…) is orchestrated ONE layer up in `folder-lifecycle.ts` through
 * the shared `ArtifactAdapter` — this store owns only the folder ROWS. The row ops
 * exposed here (archive/restore/delete a folder + its descendant rows) are the row
 * half of that cascade.
 */

export type FolderTab = 'files' | 'knowledge' | 'data' | 'metrics';
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

type FoldersState = { store: Map<string, FolderNode>; hydration: Promise<void> | null };
const FOLDERS_KEY = Symbol.for('soa.folders.store');
function st(): FoldersState {
  const g = globalThis as unknown as Record<symbol, FoldersState | undefined>;
  if (!g[FOLDERS_KEY]) g[FOLDERS_KEY] = { store: new Map(), hydration: null };
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
  for (const n of docs as FolderNode[]) {
    if (n && n.id && !s.store.has(n.id)) s.store.set(n.id, n);
  }
}

export async function ensureHydrated(): Promise<void> {
  const s = st();
  if (!s.hydration) s.hydration = Promise.all([hydrate(), versions.ensureHydrated()]).then(() => {});
  return s.hydration;
}

/** Test hook: forget every folder + version, reset the mirror probe. */
export function __resetStore(): void {
  const s = st();
  s.store.clear();
  s.hydration = null;
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
    // Personal folders are keyed by owner; domain folders by domain.
    if (scope === 'personal' ? n.owner === owner : n.domain === domain) return n;
  }
  return undefined;
}

// ----------------------------------------------------------------- reads --

/** Every folder the viewer may see in a `tab` for a `scope`. Personal → the
 *  viewer's own folders; domain → the folders shared to any of the viewer's
 *  domains. Archived folders are hidden by default (opt in via `includeArchived`).
 *  Sorted by path for a stable rail order. */
export function listFolders(
  viewer: Principal,
  tab: FolderTab,
  scope: FolderScope,
  opts: { includeArchived?: boolean } = {},
): FolderNode[] {
  const out: FolderNode[] = [];
  for (const n of st().store.values()) {
    if (n.tab !== tab || n.scope !== scope) continue;
    if (n.archived && !opts.includeArchived) continue;
    if (scope === 'personal') {
      if (n.owner === viewer.id) out.push(n);
    } else if (viewer.domains.includes(n.domain)) {
      out.push(n);
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Every folder row (tab+scope+lane peers) that IS `node` or a descendant of it.
 *  The lane is personal (owner-keyed) or domain (domain-keyed), mirroring how the
 *  rest of the store scopes. Used by the archive/restore/delete row cascade + the
 *  lifecycle orchestrator's member-item cascade. */
export function folderAndDescendants(node: FolderNode): FolderNode[] {
  const out: FolderNode[] = [];
  for (const n of st().store.values()) {
    if (n.tab !== node.tab || n.scope !== node.scope) continue;
    if (node.scope === 'personal' ? n.owner !== node.owner : n.domain !== node.domain) continue;
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
  // Rewrite this row + every descendant row that shares the `from` prefix.
  for (const n of s.store.values()) {
    if (n.tab !== node.tab || n.scope !== node.scope) continue;
    if (node.scope === 'personal' ? n.owner !== node.owner : n.domain !== node.domain) continue;
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
    versions.purge(n.id);
    deleted.push(n.id);
  }
  return deleted;
}

/** Read one folder row (no scoping — the API layer authenticates the caller). */
export function getFolder(id: string): FolderNode | undefined {
  return st().store.get(id);
}
