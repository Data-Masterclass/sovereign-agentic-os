/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { Role } from '../core/session.ts';
import {
  normaliseFolderPath,
  parentPath,
  folderName,
  renamePrefix,
} from '../core/folders.ts';
import { canManageArtifact } from '../governance/edit-scope.ts';
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
 * SAFETY: deleting a NON-EMPTY folder NEVER orphans or deletes member items — it
 * re-parents them to the folder's parent (the item side is rewritten in Wave 2;
 * here the folder rows are what we own). Deleting an EMPTY folder removes the row.
 */

export type FolderTab = 'files' | 'knowledge' | 'data';
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

/** The owner+domain the edit-scope gate reads for a folder. Personal folders are
 *  gated on the owner alone (a domain admin has no say over another user's
 *  private tree); domain folders additionally admit a domain_admin of the
 *  folder's domain. Encoded by which `domain` we hand the shared gate. */
function gateArt(node: Pick<FolderNode, 'owner' | 'domain' | 'scope'>): { owner: string; domain: string } {
  // For a personal folder, pass a domain no admin can match ('' — a user's
  // domains never include the empty string) so ONLY the owner (or platform
  // admin) passes. For a domain folder, pass its real domain.
  return { owner: node.owner, domain: node.scope === 'domain' ? node.domain : '' };
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
 *  domains. Sorted by path for a stable rail order. */
export function listFolders(viewer: Principal, tab: FolderTab, scope: FolderScope): FolderNode[] {
  const out: FolderNode[] = [];
  for (const n of st().store.values()) {
    if (n.tab !== tab || n.scope !== scope) continue;
    if (scope === 'personal') {
      if (n.owner === viewer.id) out.push(n);
    } else if (viewer.domains.includes(n.domain)) {
      out.push(n);
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
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
 * Delete a folder. EMPTY (no descendant folder rows) → the row is removed and its
 * history purged. NON-EMPTY → its immediate child folder rows are RE-PARENTED to
 * this folder's parent (never orphaned/deleted), then the row is removed. Member
 * items are re-parented on the item side in Wave 2. Edit-scoped.
 *
 * Returns the ids of every folder row that was deleted or moved, so a caller can
 * cascade the corresponding item-side rewrite.
 */
export function deleteFolder(user: Principal, id: string): { deleted: string[]; reparented: FolderNode[] } {
  const s = st();
  const node = s.store.get(id);
  if (!node) throw new FolderError('Folder not found', 404);
  requireManage(user, node);

  const parent = parentPath(node.path);
  const at = now();

  // Immediate + deeper descendants (rows strictly under this folder).
  const descendants = [...s.store.values()].filter((n) => {
    if (n.id === node.id) return false;
    if (n.tab !== node.tab || n.scope !== node.scope) return false;
    if (node.scope === 'personal' ? n.owner !== node.owner : n.domain !== node.domain) return false;
    return n.path === node.path || n.path.startsWith(node.path + '/');
  });

  const reparented: FolderNode[] = [];
  if (descendants.length > 0) {
    // Re-parent every descendant: strip the deleted segment, hang under `parent`.
    for (const n of descendants) {
      const rewritten = renamePrefix(n.path, node.path, parent);
      if (rewritten === n.path) continue;
      versions.record(n.id, user.id, n, `reparent ${n.path} → ${rewritten}`);
      n.path = rewritten;
      n.name = folderName(rewritten);
      n.updatedAt = at;
      persist(n);
      reparented.push(n);
    }
  }

  // Remove the folder row itself.
  versions.record(node.id, user.id, node, 'delete');
  s.store.delete(node.id);
  mirror.deleteThrough(node.id);
  versions.purge(node.id);

  return { deleted: [node.id], reparented };
}

/** Read one folder row (no scoping — the API layer authenticates the caller). */
export function getFolder(id: string): FolderNode | undefined {
  return st().store.get(id);
}
