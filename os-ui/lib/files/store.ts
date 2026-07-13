/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { Role } from '../core/session.ts';
import {
  type FileAsset,
  type FileKind,
  type IndexingMode,
  type Sensitivity,
  type Storage,
  type ProvenanceSource,
  AssetError,
  parseAsset,
  serializeAsset,
  emptyAsset,
  deepLinkFor,
  indexingModeFor,
} from './asset-schema.ts';
// The GOVERNANCE lifecycle is REUSED from the Data tab (read-only import): Files
// are governed exactly like Data — the same role gates, tier walk and visibility
// clamp. We do not fork it.
import {
  type Transition,
  type Grant,
  type DataVisibility,
  canTransition,
  tierAfter,
  visibilityFor,
} from '../data/dataset-schema.ts';
import { canRead } from './dls.ts';
import { canManageArtifact } from '../governance/edit-scope.ts';
import { promotionGate, gateReason } from './promotion.ts';
import { recordLineage } from './lineage.ts';
import { osMirror } from '../infra/os-mirror.ts';
import { type ArtifactVersion, versionLog } from '../core/versioning.ts';

/**
 * The file registry — the MOCK store behind the Files tab (kind-only, in-process;
 * no Supabase / object storage yet). It mirrors `lib/data/store.ts`: each record
 * persists ONE canonical source file (`asset.yaml`) plus a MOCK object-store body
 * (the extracted/preview text + a byte size) and a small version history. The
 * guided panels, the routes and the (future) ingest pipeline all read/write this
 * one source, so there is no lossy abstraction.
 *
 * Kept free of `server-only` / Next imports so it is unit-testable directly; the
 * API routes are the server boundary that authenticates + scopes callers.
 */

export type Principal = { id: string; domains: string[]; role: Role };

/** A single uploaded version's content fingerprint (the content-hash cache key). */
export type FileVersion = { version: string; hash: string; at: string; bytes: number };

/** The ORIGINAL uploaded object in the governed blob store (object-store.ts). Present
 *  for UI uploads that carried real bytes; ABSENT for text-only (MCP) records. */
export type StoredObjectMeta = { key: string; contentType: string; bytes: number };

export type FileRecord = {
  id: string;
  owner: string;
  domain: string;
  /** The single source of truth. */
  yaml: string;
  /** Extracted/preview text (docs/tables) / transcript / caption — indexed for search. */
  text: string;
  /** Byte size for display (the original object's size when one is stored). */
  bytes: number;
  /** The original bytes' location in the blob store. Null for text-only records. */
  object?: StoredObjectMeta | null;
  history: FileVersion[];
  updatedAt: string;
  /** Soft-archived: hidden from the working lists, reversible, retained. */
  archived?: boolean;
};

/** What an upload becomes Searchable as — the calm status chip (deep-design A5). */
export type FileStatus = 'processing' | 'searchable' | 'stored';

export type FileSummary = {
  id: string;
  name: string;
  owner: string;
  domain: string;
  tier: FileAsset['tier'];
  visibility: FileAsset['visibility'];
  kind: FileKind;
  folder: string;
  tags: string[];
  sensitivity: Sensitivity;
  freshness: string | null;
  version: string;
  deepLink: string;
  storage: Storage;
  status: FileStatus;
  bytes: number;
  /** Soft-archived (retained, reversible). Absent/false = live. */
  archived?: boolean;
};

export type Facets = {
  folders: { path: string; count: number }[];
  tags: { tag: string; count: number }[];
};

export type FileGroups = {
  mine: FileSummary[];
  domain: FileSummary[];
  marketplace: FileSummary[];
  facets: Facets;
};

export type SearchHit = {
  id: string;
  name: string;
  owner: string;
  folder: string;
  tags: string[];
  kind: FileKind;
  deepLink: string;
  score: number;
  snippet: string;
};

type FilesStoreState = { store: Map<string, FileRecord>; seeded: boolean; hydration: Promise<void> | null };
const FS_KEY = Symbol.for('soa.files.store');
function fs(): FilesStoreState {
  const g = globalThis as unknown as Record<symbol, FilesStoreState | undefined>;
  if (!g[FS_KEY]) g[FS_KEY] = { store: new Map(), seeded: false, hydration: null };
  return g[FS_KEY]!;
}

// ---------------------------------------------------- durable mirror (best-effort) --
const fileMirror = osMirror({
  index: 'os-file-records',
  createBody: {
    mappings: {
      properties: {
        id: { type: 'keyword' },
        owner: { type: 'keyword' },
        domain: { type: 'keyword' },
        name: { type: 'keyword' },
        status: { type: 'keyword' },
        sensitivity: { type: 'keyword' },
        updatedAt: { type: 'date' },
        tags: { type: 'keyword' },
        docs: { type: 'text', index: false },
        versions: { type: 'object', enabled: false },
        indexingMode: { type: 'keyword' },
        archived: { type: 'boolean' },
      },
    },
  },
});

// Durable, per-artifact version history (reused across the OS).
const versions = versionLog('file');

/** The versioned slice of a file record — the user-editable content + metadata. */
function snapshotState(rec: FileRecord): { yaml: string; text: string; bytes: number } {
  return { yaml: rec.yaml, text: rec.text, bytes: rec.bytes };
}

function writeThrough(rec: FileRecord): void {
  fileMirror.writeThrough(rec.id, rec);
}

export async function ensureHydrated(): Promise<void> {
  const s = fs();
  if (!s.hydration) s.hydration = Promise.all([hydrateFiles(), versions.ensureHydrated()]).then(() => {});
  return s.hydration;
}

async function hydrateFiles(): Promise<void> {
  const s = fs();
  const docs = (await fileMirror.hydrate(2000)) ?? [];
  for (const rec of docs as FileRecord[]) {
    if (rec && rec.id && !s.store.has(rec.id)) s.store.set(rec.id, rec);
  }
  s.seeded = true;
}

function now(): string {
  return new Date().toISOString();
}

function newId(): string {
  return `as_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;
}

/** Cheap deterministic content hash — the cache key the ingest pipeline (Phase 3)
 *  uses to skip re-embedding unchanged content. */
export function contentHash(content: string): string {
  let h = 0;
  for (let i = 0; i < content.length; i++) h = (Math.imul(31, h) + content.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).padStart(8, '0');
}

function fail(message: string, status: number): never {
  throw new AssetError(message, status);
}

// ------------------------------------------------------------------- seeding --

type Seed = {
  id: string; name: string; owner: string; domain: string; folder: string;
  tags: string[]; sensitivity: Sensitivity; text: string; bytes: number;
  tier?: FileAsset['tier'];
};

/** A fresh tenant starts EMPTY. Files are created only through the platform's
 *  own governed ingest flows (e.g. the Northpeak e-commerce seed), never baked in. */
const SEEDS: Seed[] = [];

function ensureSeeded(): void {
  if (fs().seeded) return;
  fs().seeded = true;
  for (const s of SEEDS) {
    const at = now();
    const a: FileAsset = emptyAsset({
      id: s.id, name: s.name, owner: s.owner, domain: s.domain,
      folder: s.folder, tags: s.tags, sensitivity: s.sensitivity, at,
    });
    if (s.tier && s.tier !== 'dataset') {
      a.tier = s.tier;
      // Promoted/certified files carry a domain grant (the policy source) + broaden.
      a.visibility = s.tier === 'product' ? 'public' : 'domain';
      a.grants = [{ grantee: { kind: 'domain', id: s.domain }, scope: { rows: [], columns: { mask: [], hide: [] } }, cardinality: 'low', action: 'read' }];
      a.deepLink = deepLinkFor(a);
    }
    a.indexing.representations = representationsFor(a.kind, a.indexing.mode);
    const rec: FileRecord = {
      id: s.id, owner: s.owner, domain: s.domain, yaml: serializeAsset(a),
      text: s.text, bytes: s.bytes,
      history: [{ version: 'v1', hash: contentHash(s.text), at, bytes: s.bytes }],
      updatedAt: at,
    };
    fs().store.set(rec.id, rec);
  }
}

/** Test hook: wipe + reseed. */
export function __resetStore(): void {
  const s = fs();
  s.store.clear();
  s.seeded = false;
  s.hydration = null;
  fileMirror.__reset();
  versions.__reset();
}

/** Which retrieval representations a kind yields (mock map; the real ingest
 *  adapters fill these in Phase 3). Stored-only files index nothing. */
function representationsFor(kind: FileKind, mode: IndexingMode): string[] {
  if (mode === 'stored-only') return [];
  switch (kind) {
    case 'doc': return ['text'];
    case 'table': return ['table', 'text'];
    case 'audio':
    case 'video': return ['transcript'];
    case 'image': return ['caption', 'ocr'];
    default: return ['text'];
  }
}

// ------------------------------------------------------------------- scoping --

function get(id: string): FileRecord {
  ensureSeeded();
  const rec = fs().store.get(id);
  if (!rec) fail('File not found', 404);
  return rec;
}

/** Who can SEE a file — decided by the COMPILED DLS filter (dls.ts), the same rule
 *  OpenSearch enforces live. One policy source: owner / product / domain-asset /
 *  named-grant. Private files are owner-only. */
function canView(a: FileAsset, user: Principal): boolean {
  return canRead(a, { id: user.id, domains: user.domains });
}

function canEdit(a: FileAsset, user: Principal): boolean {
  // Fail-closed edit-scope: owner, domain_admin of the owning domain, or admin.
  return canManageArtifact(user, { owner: a.owner, domain: a.domain });
}

function viewOf(rec: FileRecord, user: Principal): FileAsset {
  const a = parseAsset(rec.yaml);
  if (!canView(a, user)) fail('Not permitted to view this file', 403);
  return a;
}

function editOf(rec: FileRecord, user: Principal): FileAsset {
  const a = parseAsset(rec.yaml);
  if (!canEdit(a, user)) fail('Not permitted to edit this file', 403);
  return a;
}

function persist(rec: FileRecord, a: FileAsset): FileRecord {
  rec.yaml = serializeAsset(a);
  rec.owner = a.owner;
  rec.domain = a.domain;
  rec.updatedAt = now();
  writeThrough(rec);
  return rec;
}

// --------------------------------------------------------------------- lists --

function statusOf(a: FileAsset): FileStatus {
  return a.indexing.mode === 'stored-only' ? 'stored' : 'searchable';
}

function summarise(a: FileAsset, rec: FileRecord): FileSummary {
  return {
    id: a.id, name: a.name, owner: a.owner, domain: a.domain,
    tier: a.tier, visibility: a.visibility, kind: a.kind, folder: a.folder,
    tags: a.tags, sensitivity: a.sensitivity, freshness: a.freshness,
    version: a.version, deepLink: a.deepLink, storage: a.storage,
    status: statusOf(a), bytes: rec.bytes,
    archived: rec.archived ?? false,
  };
}

function facetsOf(summaries: FileSummary[]): Facets {
  const folders = new Map<string, number>();
  const tags = new Map<string, number>();
  for (const s of summaries) {
    folders.set(s.folder, (folders.get(s.folder) ?? 0) + 1);
    for (const t of s.tags) tags.set(t, (tags.get(t) ?? 0) + 1);
  }
  return {
    folders: [...folders.entries()].map(([path, count]) => ({ path, count })).sort((a, b) => a.path.localeCompare(b.path)),
    tags: [...tags.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)),
  };
}

export function listFiles(user: Principal, opts: { includeArchived?: boolean } = {}): FileGroups {
  ensureSeeded();
  const mine: FileSummary[] = [];
  const domain: FileSummary[] = [];
  const marketplace: FileSummary[] = [];
  const owned: FileSummary[] = []; // the caller's whole drive — drives the facet rail
  for (const rec of fs().store.values()) {
    if (rec.archived && !opts.includeArchived) continue;
    const a = parseAsset(rec.yaml);
    if (!canView(a, user)) continue;
    const s = summarise(a, rec);
    if (a.owner === user.id) owned.push(s);
    // Group by VISIBILITY (tier), not ownership: a promoted asset is domain content and
    // belongs under Domain even when the caller authored it; a certified product under
    // Marketplace; a private file (owner-only, via canView) under Personal.
    if (a.tier === 'product') marketplace.push(s);
    else if (a.tier === 'asset') domain.push(s);
    else mine.push(s);
  }
  const byName = (x: FileSummary, y: FileSummary) => x.folder.localeCompare(y.folder) || x.name.localeCompare(y.name);
  mine.sort(byName); domain.sort(byName); marketplace.sort(byName);
  // Facets describe the OWNER's own drive (the folder rail / tag cloud) across every tier.
  return { mine, domain, marketplace, facets: facetsOf(owned) };
}

export type FileView = { asset: FileAsset; text: string; bytes: number; object: StoredObjectMeta | null; history: FileVersion[]; archived: boolean };

export function getFile(id: string, user: Principal): FileView {
  const rec = get(id);
  const a = viewOf(rec, user);
  // The archived flag lives on the RECORD — surface it on the returned view so the
  // detail's lifecycle cluster shows the real state (Restore + Delete when archived).
  return { asset: a, text: rec.text, bytes: rec.bytes, object: rec.object ?? null, history: rec.history, archived: rec.archived ?? false };
}

/**
 * The object key for a stored file — the store's prefix invariant (`s3://files/<owner|
 * domain>/…`) minus the `s3://<bucket>/` scheme, i.e. the key WITHIN the files bucket.
 * `null` for in-place references (nothing of ours to serve).
 */
export function objectKeyForAsset(a: FileAsset): string | null {
  if (a.storage !== 'object-store') return null;
  const m = /^s3:\/\/[^/]+\/(.+)$/.exec(a.deepLink);
  return m ? m[1] : null;
}

/**
 * Record that the ORIGINAL bytes for a file were stored (by the server route) in the
 * blob store. Owner-gated (`editOf`) — only someone who may edit the file may attach
 * its object. The key is derived from the asset's governed deep-link, so it always
 * matches the file's visibility prefix.
 */
export function attachObject(id: string, user: Principal, meta: { contentType: string; bytes: number }): StoredObjectMeta {
  const rec = get(id);
  const a = editOf(rec, user); // owner/admin gate
  const key = objectKeyForAsset(a);
  if (!key) fail('This file has no object-store location', 400);
  const object: StoredObjectMeta = { key, contentType: meta.contentType, bytes: meta.bytes };
  rec.object = object;
  rec.bytes = meta.bytes;
  rec.updatedAt = now();
  writeThrough(rec);
  return object;
}

// ------------------------------------------------------------- create / edit --

export type UploadInput = {
  name: string;
  folder?: string;
  tags?: string[];
  sensitivity?: Sensitivity;
  storage?: Storage;
  /** Mock extracted/preview text (transcript/caption/body). */
  text?: string;
  bytes?: number;
  provenanceSource?: ProvenanceSource;
  sourceUri?: string;
  domain?: string;
  /** Explicit index opt-out at upload time (else derived from sensitivity). */
  indexing?: IndexingMode;
};

/** Upload a new file → a private object-store file at v1 (or an in-place reference). */
export function createFile(user: Principal, input: UploadInput): FileAsset {
  ensureSeeded();
  if (!input.name || !input.name.trim()) fail('a file needs a name', 400);
  const domain = input.domain && user.domains.includes(input.domain) ? input.domain : user.domains[0] ?? 'platform';
  const at = now();
  const a = emptyAsset({
    id: newId(), name: input.name.trim(), owner: user.id, domain,
    folder: input.folder, tags: input.tags, sensitivity: input.sensitivity,
    storage: input.storage, provenanceSource: input.provenanceSource, sourceUri: input.sourceUri, at,
  });
  const text = input.text ?? '';
  a.indexing.mode = indexingModeFor(a.sensitivity, input.indexing);
  // Honesty: an upload with no extractable text (e.g. a binary the mock parser
  // can't read yet) indexes zero chunks, so it is HELD, not searchable. Reflect
  // that as `stored-only` instead of falsely reporting "Searchable ✓".
  if (a.indexing.mode === 'indexed' && !text.trim()) a.indexing.mode = 'stored-only';
  a.indexing.representations = representationsFor(a.kind, a.indexing.mode);
  const bytes = input.bytes ?? text.length;
  const rec: FileRecord = {
    id: a.id, owner: a.owner, domain: a.domain, yaml: serializeAsset(a),
    text, bytes,
    history: [{ version: 'v1', hash: contentHash(text), at, bytes }],
    updatedAt: at,
  };
  fs().store.set(rec.id, rec);
  writeThrough(rec);
  return a;
}

/**
 * Governed offboard support: transfer this owner's PERSONAL-lane records to a new
 * owner (used by lib/platform-admin/offboard.ts when a user is offboarded with
 * reassignment). Only personal, owner-only artifacts move; shared/domain/certified
 * are untouched. Returns the count moved.
 */
export function reassignOwner(fromId: string, toId: string): number {
  let moved = 0;
  for (const rec of fs().store.values()) {
    if (rec.owner !== fromId) continue;
    const a = parseAsset(rec.yaml);
    if (a.tier !== 'dataset') continue; // personal lane only
    // Owner lives on both the record (mirror key) and the serialized yaml (which
    // drives canView/DLS) — rewrite both so the new owner can see the asset.
    a.owner = toId;
    rec.owner = toId;
    rec.yaml = serializeAsset(a);
    rec.updatedAt = now();
    writeThrough(rec);
    moved++;
  }
  return moved;
}

export function moveFile(id: string, user: Principal, folder: string): FileAsset {
  const rec = get(id);
  const a = editOf(rec, user);
  versions.record(rec.id, user.id, snapshotState(rec), 'edit folder');
  a.folder = normalise(folder);
  a.deepLink = deepLinkFor(a);
  persist(rec, a);
  return a;
}

export function setTags(id: string, user: Principal, tags: string[]): FileAsset {
  const rec = get(id);
  const a = editOf(rec, user);
  versions.record(rec.id, user.id, snapshotState(rec), 'edit tags');
  a.tags = tags.map((t) => t.trim()).filter(Boolean);
  persist(rec, a);
  return a;
}

/** The promotion-minimum documentation (decision #5: owner + description + tags).
 *  Owner is intrinsic; this writes description + (optionally) tags. */
export function setDocs(id: string, user: Principal, docs: { description?: string; tags?: string[] }): FileAsset {
  const rec = get(id);
  const a = editOf(rec, user);
  versions.record(rec.id, user.id, snapshotState(rec), 'edit docs');
  if (docs.description !== undefined) a.description = docs.description;
  if (docs.tags !== undefined) a.tags = docs.tags.map((t) => t.trim()).filter(Boolean);
  persist(rec, a);
  return a;
}

/** Re-upload → bump the content version and record history (drag-drop versioning). */
export function addVersion(id: string, user: Principal, input: { text?: string; bytes?: number }): FileAsset {
  const rec = get(id);
  const a = editOf(rec, user);
  versions.record(rec.id, user.id, snapshotState(rec), 'content upload');
  const n = rec.history.length + 1;
  const at = now();
  const text = input.text ?? rec.text;
  const bytes = input.bytes ?? (input.text !== undefined ? text.length : rec.bytes);
  a.version = `v${n}`;
  a.freshness = at;
  rec.text = text;
  rec.bytes = bytes;
  rec.history.push({ version: a.version, hash: contentHash(text), at, bytes });
  persist(rec, a);
  return a;
}

/** Opt a file in/out of indexing (stored-but-not-indexed for sensitive/huge files). */
export function setIndexingMode(id: string, user: Principal, mode: IndexingMode): FileAsset {
  const rec = get(id);
  const a = editOf(rec, user);
  versions.record(rec.id, user.id, snapshotState(rec), 'edit indexing');
  a.indexing.mode = indexingModeFor(a.sensitivity, mode);
  a.indexing.representations = representationsFor(a.kind, a.indexing.mode);
  persist(rec, a);
  return a;
}

export function setSensitivity(id: string, user: Principal, sensitivity: Sensitivity): FileAsset {
  const rec = get(id);
  const a = editOf(rec, user);
  versions.record(rec.id, user.id, snapshotState(rec), 'edit sensitivity');
  a.sensitivity = sensitivity;
  // Re-clamp indexing (restricted ⇒ stored-only).
  a.indexing.mode = indexingModeFor(sensitivity, a.indexing.mode);
  a.indexing.representations = representationsFor(a.kind, a.indexing.mode);
  persist(rec, a);
  return a;
}

/**
 * Permanently delete a file (edit-scoped, irreversible). Removes the registry record,
 * its version history and its durable mirror doc. Returns the deleted record so the
 * route can PHYSICALLY purge its object-store bytes (physical-delete.ts) — a "deleted"
 * file whose bytes still sit in MinIO isn't deleted. Archive (below) never purges.
 */
export function deleteFile(id: string, user: Principal): FileRecord {
  const rec = get(id);
  const a = parseAsset(rec.yaml);
  if (!canEdit(a, user)) fail('Not permitted to delete this file', 403);
  versions.purge(id);
  fileMirror.deleteThrough(id);
  fs().store.delete(id);
  return rec;
}

// -------------------------------------------- archive / delete / versions --

/**
 * Archive a file: a reversible soft-hide. Edit-scoped — only the owner or
 * an in-domain Admin may archive (exactly like editing). The record + its
 * history are retained; the file leaves the working lists until unarchived.
 */
export function archiveFile(id: string, user: Principal): FileRecord {
  const rec = get(id);
  const a = parseAsset(rec.yaml);
  if (!canEdit(a, user)) fail('Not permitted to archive this file', 403);
  rec.archived = true;
  rec.updatedAt = now();
  writeThrough(rec);
  return rec;
}

/** Restore an archived file back into the working lists (edit-scoped). */
export function unarchiveFile(id: string, user: Principal): FileRecord {
  const rec = get(id);
  const a = parseAsset(rec.yaml);
  if (!canEdit(a, user)) fail('Not permitted to unarchive this file', 403);
  rec.archived = false;
  rec.updatedAt = now();
  writeThrough(rec);
  return rec;
}

/** Version history for a file, newest first (view-scoped). */
export function listFileVersions(id: string, user: Principal): ArtifactVersion[] {
  const rec = get(id);
  viewOf(rec, user); // view-scoped: any viewer may see the history
  return versions.list(id);
}

/**
 * Restore a prior version of a file's content + metadata. Restore is itself
 * auditable + reversible: the CURRENT state is snapshotted as a new version
 * first, THEN the chosen version's state is applied. Edit-scoped.
 */
export function restoreFileVersion(id: string, user: Principal, version: number): FileRecord {
  const rec = get(id);
  const a = parseAsset(rec.yaml);
  if (!canEdit(a, user)) fail('Not permitted to restore this file', 403);
  const snap = versions.get(id, version);
  if (!snap) fail(`Version ${version} not found`, 404);
  const s = snap.state as { yaml?: string; text?: string; bytes?: number };
  if (typeof s.yaml !== 'string') fail(`Version ${version} has no restorable source`, 422);
  parseAsset(s.yaml); // validate before applying — never go live with corrupt state
  // Snapshot the live state first so the restore can itself be undone.
  versions.record(id, user.id, snapshotState(rec), `restore of v${version}`);
  rec.yaml = s.yaml;
  if (typeof s.text === 'string') rec.text = s.text;
  if (typeof s.bytes === 'number') rec.bytes = s.bytes;
  rec.updatedAt = now();
  writeThrough(rec);
  return rec;
}

// -------------------------------------------------------------------- search --

function normalise(folder: string): string {
  const parts = String(folder ?? '').split('/').map((s) => s.trim()).filter(Boolean);
  return '/' + parts.join('/');
}

function tokens(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/**
 * Phase-1 search — full-text + a lightweight semantic-ish blend over the files a
 * user may see and that are INDEXED (stored-only files are excluded). This is the
 * UI search box; the agent-grade hybrid (BM25 + kNN + neural-sparse) hybrid +
 * rerank + DLS lands in Phase 5's `retrieve.ts`. Exact-substring is kept alongside
 * token overlap so names/IDs still match (context-layer: keep exact-match).
 */
export function searchFiles(user: Principal, query: string): SearchHit[] {
  ensureSeeded();
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const qTokens = new Set(tokens(q));
  const hits: SearchHit[] = [];
  for (const rec of fs().store.values()) {
    if (rec.archived) continue; // archived files are not searchable
    const a = parseAsset(rec.yaml);
    if (!canView(a, user)) continue;
    if (a.indexing.mode === 'stored-only') continue; // not indexed → not searchable
    const hay = `${a.name} ${a.folder} ${a.tags.join(' ')} ${rec.text}`.toLowerCase();
    let score = 0;
    // Exact-substring (names/IDs/phrases) — strong signal.
    if (hay.includes(q)) score += 3;
    if (a.name.toLowerCase().includes(q)) score += 2;
    if (a.tags.some((t) => t.toLowerCase() === q)) score += 2;
    // Token overlap (the "semantic"-ish recall over the body/transcript/caption).
    const hayTokens = tokens(hay);
    const overlap = hayTokens.filter((t) => qTokens.has(t)).length;
    score += overlap;
    if (score <= 0) continue;
    hits.push({
      id: a.id, name: a.name, owner: a.owner, folder: a.folder, tags: a.tags,
      kind: a.kind, deepLink: a.deepLink, score, snippet: snippetOf(rec.text, qTokens),
    });
  }
  return hits.sort((x, y) => y.score - x.score || x.name.localeCompare(y.name)).slice(0, 20);
}

/** A short highlight window around the first matching token. */
function snippetOf(text: string, qTokens: Set<string>): string {
  if (!text) return '';
  const words = text.split(/\s+/);
  const idx = words.findIndex((w) => qTokens.has(w.toLowerCase().replace(/[^a-z0-9]/g, '')));
  if (idx < 0) return text.slice(0, 140) + (text.length > 140 ? '…' : '');
  const start = Math.max(0, idx - 8);
  const end = Math.min(words.length, idx + 12);
  return (start > 0 ? '…' : '') + words.slice(start, end).join(' ') + (end < words.length ? '…' : '');
}

// ------------------------------------------------- lifecycle (Phase 2: govern) --

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'file';
}

/** The governed object-store target a promotion writes to (the domain prefix). */
export function assetTarget(a: FileAsset): string {
  return `s3://files/${a.domain}/${slug(a.name)}`;
}

export type FilePromotionRequest = {
  fileId: string;
  fileName: string;
  domain: string;
  owner: string;
  visibility: DataVisibility;
  grants: Grant[];
  target: string;
};

/**
 * A Creator REQUESTS promotion of their OWN file (separation of duties — they
 * cannot promote it themselves; a domain Builder approves). We validate ownership,
 * that it is still private, and that the LIGHT docs gate is green (owner +
 * description + ≥1 tag, decision #5). The caller enqueues the returned request
 * into the shared approvals queue.
 */
export function requestPromotion(
  id: string,
  user: Principal,
  opts: { visibility?: DataVisibility; grants?: Grant[] } = {},
): FilePromotionRequest {
  const rec = get(id);
  const a = parseAsset(rec.yaml);
  if (a.owner !== user.id) fail('Only the file owner can request its promotion', 403);
  if (a.tier !== 'dataset') fail('This file is already shared', 409);
  const gate = promotionGate(a);
  if (!gate.ok) fail(`Cannot promote — ${gateReason(gate)}.`, 400);
  return {
    fileId: a.id,
    fileName: a.name,
    domain: a.domain,
    owner: a.owner,
    visibility: visibilityFor('asset', opts.visibility ?? 'domain'),
    grants: opts.grants ?? [{ grantee: { kind: 'domain', id: a.domain }, scope: { rows: [], columns: { mask: [], hide: [] } }, cardinality: 'low', action: 'read' }],
    target: assetTarget(a),
  };
}

/**
 * Apply an APPROVED promotion. The approval IS the authorization, so ownership is
 * NOT required — but the approver must be a domain Builder/Admin (role gate), and
 * the docs gate is re-checked. This is the Creator→Builder handoff: it moves the
 * file dataset→asset, RE-GOVERNS it (the bytes move from the owner prefix to the
 * DOMAIN prefix — deepLink re-derived), sets the policy grants, and emits OM
 * lineage. The same DLS filter then makes it visible to the domain, denied to others.
 */
export function applyApprovedFilePromotion(req: FilePromotionRequest, approver: Principal): FileAsset {
  const rec = get(req.fileId);
  const a = parseAsset(rec.yaml);
  if (a.tier !== 'dataset') fail('File is no longer pending promotion', 409);
  if (!approver.domains.includes(a.domain)) fail('A promotion is approved by a Builder in the file’s domain', 403);
  const roleGate = canTransition(approver.role, 'dataset', 'promote');
  if (!roleGate.ok) fail(roleGate.reason ?? 'promotion requires a Builder', 403);
  const gate = promotionGate(a);
  if (!gate.ok) fail(`Promotion blocked — ${gateReason(gate)}`, 400);

  a.tier = 'asset';
  a.visibility = visibilityFor('asset', req.visibility);
  a.grants = req.grants;
  a.deepLink = deepLinkFor(a); // re-governed: now under the domain prefix
  persist(rec, a);
  recordLineage({ kind: 'file_promoted', fileId: a.id, fileName: a.name, target: req.target, by: approver.id });
  return a;
}

/**
 * Move a file along the sharing lifecycle directly (certify / unshare / decertify).
 * Separation of duties via the REUSED `canTransition`; the editor must be able to
 * edit the file. Certify (asset→product) is an Admin act; unshare/decertify are the
 * reverse moves. Promotion (dataset→asset) goes through the request/approve path.
 */
export function transition(
  id: string,
  user: Principal,
  t: Transition,
  opts: { visibility?: DataVisibility; grants?: Grant[] } = {},
): FileAsset {
  const rec = get(id);
  const a = parseAsset(rec.yaml);
  if (!canEdit(a, user)) fail('Not permitted to change this file', 403);
  const gate = canTransition(user.role, a.tier, t);
  if (!gate.ok) fail(gate.reason ?? 'transition not allowed', 403);

  const to = tierAfter(a.tier, t);
  a.tier = to;
  a.visibility = visibilityFor(to, opts.visibility ?? a.visibility);
  if (opts.grants) a.grants = opts.grants;
  if (to === 'dataset') a.grants = []; // back to private — nothing shared
  a.deepLink = deepLinkFor(a);
  persist(rec, a);
  const kind = t === 'certify' ? 'file_certified' : t === 'unshare' ? 'file_unshared' : 'file_promoted';
  recordLineage({ kind, fileId: a.id, fileName: a.name, target: assetTarget(a), by: user.id });
  return a;
}

/** The docs-gate status for the promote affordance (UI shows the exact gap). */
export function promotionStatus(id: string, user: Principal): { tier: FileAsset['tier']; gate: ReturnType<typeof promotionGate> } {
  const a = viewOf(get(id), user);
  return { tier: a.tier, gate: promotionGate(a) };
}

// ------------------------------------------------- index bootstrap (server) --

/** Every file with its current body — SERVER-INTERNAL only (the index pipeline
 *  re-hydrates the hybrid index from the store). NOT user-scoped: callers must be
 *  the trusted server pipeline, never a user request. */
export function listAllForIndex(): { asset: FileAsset; text: string }[] {
  ensureSeeded();
  return [...fs().store.values()].map((rec) => ({ asset: parseAsset(rec.yaml), text: rec.text }));
}

/** One file's body for re-indexing after an edit (server-internal). */
export function bodyForIndex(id: string): { asset: FileAsset; text: string } | null {
  ensureSeeded();
  const rec = fs().store.get(id);
  return rec ? { asset: parseAsset(rec.yaml), text: rec.text } : null;
}
