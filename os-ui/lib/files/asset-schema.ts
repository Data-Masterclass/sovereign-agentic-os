/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import yaml from 'js-yaml';
import {
  type Tier,
  type DataVisibility,
  type Grant,
  type Grantee,
  TIERS,
  visibilityFor,
} from '../data/dataset-schema.ts';

/**
 * `asset.yaml` — the SINGLE source of truth for one file in the Files tab.
 *
 * Files are **unstructured context products** (context-layer-design.md): each file
 * carries ONE metadata envelope so retrieval + governance are reusable across
 * Files / Knowledge / Data. The GOVERNANCE half of that envelope — the
 * dataset→asset→product lifecycle, the role gates, the visibility clamp and the
 * `grants` policy source — is **re-used verbatim from the Data tab**
 * (`lib/data/dataset-schema.ts`); we do NOT fork it. This module adds only the
 * FILE-specific fields (kind, folder, tags, sensitivity, storage, indexing, …).
 *
 * Pure module — no server-only / network imports — so the store, the (future)
 * policy/DLS compiler, the routes and the tests all share it. SHAPE validation only.
 *
 * NOTE: `Tier` reads dataset|asset|product but for files those mean the SHARING
 * states private | domain-shared | marketplace — the same lifecycle, different store.
 */

export type FileKind = 'doc' | 'image' | 'video' | 'audio' | 'table' | 'archive' | 'other';

/** Curation label (handover §sensitivity). `restricted` ⇒ auto stored-only (decision #7). */
export type Sensitivity = 'public' | 'internal' | 'confidential' | 'restricted';

/** Where the bytes live: our governed object store, or referenced in the source drive. */
export type Storage = 'object-store' | 'in-place';

/** Indexed = parsed+embedded+searchable; stored-only = held but never indexed. */
export type IndexingMode = 'indexed' | 'stored-only';

export const FILE_KINDS: FileKind[] = ['doc', 'image', 'video', 'audio', 'table', 'archive', 'other'];
export const SENSITIVITIES: Sensitivity[] = ['public', 'internal', 'confidential', 'restricted'];
const STORAGES: Storage[] = ['object-store', 'in-place'];

/** How a file got here (provenance/citations — non-negotiable, context-layer §provenance). */
export type ProvenanceSource = 'upload' | 'google-drive' | 'onedrive' | 's3';

export type Provenance = {
  source: ProvenanceSource;
  /** The original location for connected/referenced files. */
  sourceUri?: string;
  addedBy: string;
  addedAt: string;
};

/** A typed edge to another context object (file → derived knowledge/dataset, etc.). */
export type Relationship = {
  kind: 'derived-from' | 'derived-to' | 'duplicate-of' | 'references';
  targetId: string;
  note?: string;
};

/** The retrieval side of the envelope (filled by the Phase-3 ingest pipeline). */
export type Indexing = {
  mode: IndexingMode;
  /** Which representations exist (text / transcript / caption / table). */
  representations: string[];
  /** Per-chunk content hashes — the content-hash cache that skips re-embeds. */
  chunkHashes: string[];
};

export type FileAsset = {
  /** asset.yaml format version (NOT the file's content version). */
  schemaVersion: string;
  id: string;
  name: string;
  owner: string;
  domain: string;
  /** Sharing state — REUSED Data lifecycle (dataset=private, asset=domain, product=market). */
  tier: Tier;
  visibility: DataVisibility;
  description: string;
  /** Context-layer envelope tag, e.g. `file.pdf` / `file.audio`. Derived from `kind`. */
  assetType: string;
  kind: FileKind;
  /** Folder path, always normalised to a leading slash; '/' is the root. */
  folder: string;
  tags: string[];
  sensitivity: Sensitivity;
  /** Effective-date / freshness (ISO) — drives trust/freshness reranking later. */
  freshness: string | null;
  /** The file's CONTENT version (e.g. 'v1', 'v2'); re-upload bumps it. */
  version: string;
  /** Canonical deep-link (s3://files/… for stored, source URI for in-place). */
  deepLink: string;
  provenance: Provenance;
  relationships: Relationship[];
  storage: Storage;
  indexing: Indexing;
  /** The ONE policy source the DLS/OPA compiler reads (same as Data `grants`). */
  grants: Grant[];
};

export class AssetError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'AssetError';
    this.status = status;
  }
}

// ----------------------------------------------------------------- file kind --

const EXT_KIND: Record<string, FileKind> = {
  pdf: 'doc', doc: 'doc', docx: 'doc', txt: 'doc', md: 'doc', rtf: 'doc', odt: 'doc', pptx: 'doc', ppt: 'doc',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image', heic: 'image', tiff: 'image',
  mp4: 'video', mov: 'video', mkv: 'video', webm: 'video', avi: 'video',
  mp3: 'audio', m4a: 'audio', wav: 'audio', aac: 'audio', flac: 'audio', ogg: 'audio',
  csv: 'table', xlsx: 'table', xls: 'table', tsv: 'table', parquet: 'table',
  zip: 'archive', tar: 'archive', gz: 'archive', rar: 'archive', '7z': 'archive',
};

export function fileKindFromName(name: string): FileKind {
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return 'other';
  const ext = name.slice(dot + 1).toLowerCase();
  return EXT_KIND[ext] ?? 'other';
}

export function assetTypeFor(kind: FileKind): string {
  return `file.${kind}`;
}

// ------------------------------------------------------------ object storage --

/**
 * THE OBJECT-STORE PREFIX (handover decision #4 — the `storageFor` analog). Private
 * files (tier `dataset`) live under the OWNER's prefix; shared/certified files
 * (tier `asset`/`product`) live under the DOMAIN's prefix. This is the one place
 * the private↔governed object-store line is drawn.
 */
export function objectPrefixFor(tier: Tier, owner: string, domain: string): string {
  return tier === 'dataset' ? `s3://files/${owner}/` : `s3://files/${domain}/`;
}

/** Normalise a folder to a single leading slash, no trailing slash; '' → '/'. */
export function normaliseFolder(folder: string | undefined | null): string {
  if (!folder) return '/';
  const parts = String(folder).split('/').map((s) => s.trim()).filter(Boolean);
  return '/' + parts.join('/');
}

/** The canonical deep-link. Stored files compose it from prefix+folder+name; in-place
 *  files keep whatever source URI they were referenced from. */
export function deepLinkFor(a: FileAsset): string {
  if (a.storage === 'in-place') return a.deepLink;
  const prefix = objectPrefixFor(a.tier, a.owner, a.domain);
  const folder = a.folder === '/' ? '' : a.folder.replace(/^\//, '') + '/';
  return `${prefix}${folder}${a.name}`;
}

/** Restricted files are NEVER indexed (decision #7); everything else honours the
 *  requested mode (default indexed — "all supported files indexed, curated"). */
export function indexingModeFor(sensitivity: Sensitivity, requested?: IndexingMode): IndexingMode {
  if (sensitivity === 'restricted') return 'stored-only';
  return requested ?? 'indexed';
}

export function emptyIndexing(mode: IndexingMode = 'indexed'): Indexing {
  return { mode, representations: [], chunkHashes: [] };
}

// -------------------------------------------------------------------- parsing --

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function strArray(v: unknown, where: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new AssetError(`asset.yaml: '${where}' must be a list`);
  return v.map((x) => String(x));
}

function parseProvenance(v: unknown): Provenance {
  const r = isRecord(v) ? v : {};
  const source = (r.source ?? 'upload') as ProvenanceSource;
  const sources: ProvenanceSource[] = ['upload', 'google-drive', 'onedrive', 's3'];
  return {
    source: sources.includes(source) ? source : 'upload',
    sourceUri: typeof r.sourceUri === 'string' ? r.sourceUri : undefined,
    addedBy: typeof r.addedBy === 'string' ? r.addedBy : '',
    addedAt: typeof r.addedAt === 'string' ? r.addedAt : '',
  };
}

function parseRelationship(raw: unknown, i: number): Relationship {
  if (!isRecord(raw) || typeof raw.targetId !== 'string' || raw.targetId.length === 0) {
    throw new AssetError(`asset.yaml: relationships[${i}] needs a string 'targetId'`);
  }
  const kinds: Relationship['kind'][] = ['derived-from', 'derived-to', 'duplicate-of', 'references'];
  const kind = (raw.kind ?? 'references') as Relationship['kind'];
  return {
    kind: kinds.includes(kind) ? kind : 'references',
    targetId: raw.targetId,
    note: typeof raw.note === 'string' ? raw.note : undefined,
  };
}

function parseIndexing(v: unknown, sensitivity: Sensitivity): Indexing {
  const r = isRecord(v) ? v : {};
  const requested = (r.mode === 'stored-only' ? 'stored-only' : 'indexed') as IndexingMode;
  return {
    // The restricted ⇒ stored-only invariant is enforced HERE, in one place.
    mode: indexingModeFor(sensitivity, requested),
    representations: strArray(r.representations, 'indexing.representations'),
    chunkHashes: strArray(r.chunkHashes, 'indexing.chunkHashes'),
  };
}

function parseGrant(raw: unknown, i: number): Grant {
  if (!isRecord(raw)) throw new AssetError(`asset.yaml: grants[${i}] must be a mapping`);
  const g = isRecord(raw.grantee) ? raw.grantee : {};
  const kind = g.kind as Grantee['kind'];
  if (!['user', 'group', 'domain', 'role'].includes(kind)) {
    throw new AssetError(`asset.yaml: grants[${i}].grantee.kind invalid (user|group|domain|role)`);
  }
  if (typeof g.id !== 'string' || g.id.length === 0) {
    throw new AssetError(`asset.yaml: grants[${i}].grantee.id required`);
  }
  const scopeRaw = isRecord(raw.scope) ? raw.scope : {};
  const colsRaw = isRecord(scopeRaw.columns) ? scopeRaw.columns : {};
  const cardinality = raw.cardinality === 'high' ? 'high' : 'low';
  return {
    grantee: { kind, id: g.id },
    scope: {
      rows: strArray(scopeRaw.rows, `grants[${i}].scope.rows`),
      columns: {
        mask: strArray(colsRaw.mask, `grants[${i}].scope.columns.mask`),
        hide: strArray(colsRaw.hide, `grants[${i}].scope.columns.hide`),
      },
    },
    cardinality,
    action: 'read',
  };
}

export function parseAsset(input: string | Record<string, unknown>): FileAsset {
  let doc: unknown;
  if (typeof input === 'string') {
    try {
      doc = yaml.load(input);
    } catch (e) {
      throw new AssetError(`asset.yaml: not valid YAML — ${(e as Error).message}`);
    }
  } else {
    doc = input;
  }
  if (!isRecord(doc)) throw new AssetError('asset.yaml: expected a mapping at the document root');

  const tier = (doc.tier ?? 'dataset') as Tier;
  if (!TIERS.includes(tier)) throw new AssetError(`asset.yaml: tier '${String(doc.tier)}' invalid (${TIERS.join('|')})`);

  const sensitivity = (doc.sensitivity ?? 'internal') as Sensitivity;
  if (!SENSITIVITIES.includes(sensitivity)) {
    throw new AssetError(`asset.yaml: sensitivity '${String(doc.sensitivity)}' invalid (${SENSITIVITIES.join('|')})`);
  }

  const name = typeof doc.name === 'string' && doc.name.length > 0 ? doc.name : 'untitled';
  const kindRaw = (doc.kind ?? fileKindFromName(name)) as FileKind;
  const kind = FILE_KINDS.includes(kindRaw) ? kindRaw : fileKindFromName(name);

  const storage = (doc.storage === 'in-place' ? 'in-place' : 'object-store') as Storage;
  if (!STORAGES.includes(storage)) throw new AssetError(`asset.yaml: storage invalid (${STORAGES.join('|')})`);

  const visRaw = (doc.visibility ?? 'private') as DataVisibility;

  const relRaw = Array.isArray(doc.relationships) ? doc.relationships : [];
  const grantsRaw = Array.isArray(doc.grants) ? doc.grants : [];

  const asset: FileAsset = {
    schemaVersion: doc.schemaVersion !== undefined ? String(doc.schemaVersion) : '1',
    id: typeof doc.id === 'string' ? doc.id : '',
    name,
    owner: typeof doc.owner === 'string' ? doc.owner : '',
    domain: typeof doc.domain === 'string' ? doc.domain : '',
    tier,
    visibility: visibilityFor(tier, visRaw),
    description: typeof doc.description === 'string' ? doc.description : '',
    assetType: assetTypeFor(kind),
    kind,
    folder: normaliseFolder(typeof doc.folder === 'string' ? doc.folder : '/'),
    tags: strArray(doc.tags, 'tags').map((t) => t.trim()).filter(Boolean),
    sensitivity,
    freshness: typeof doc.freshness === 'string' ? doc.freshness : null,
    version: doc.version !== undefined ? String(doc.version) : 'v1',
    deepLink: typeof doc.deepLink === 'string' ? doc.deepLink : '',
    provenance: parseProvenance(doc.provenance),
    relationships: relRaw.map(parseRelationship),
    storage,
    indexing: parseIndexing(doc.indexing, sensitivity),
    grants: grantsRaw.map(parseGrant),
  };
  // Keep the deep-link canonical for stored files (derive it; in-place keeps source).
  if (storage === 'object-store') asset.deepLink = deepLinkFor(asset);
  return asset;
}

export function serializeAsset(a: FileAsset): string {
  const doc: Record<string, unknown> = {
    schemaVersion: a.schemaVersion,
    id: a.id,
    name: a.name,
    owner: a.owner,
    domain: a.domain,
    tier: a.tier,
    visibility: a.visibility,
    kind: a.kind,
    folder: a.folder,
    sensitivity: a.sensitivity,
    version: a.version,
    storage: a.storage,
    deepLink: a.deepLink,
  };
  if (a.description) doc.description = a.description;
  if (a.tags.length > 0) doc.tags = a.tags;
  if (a.freshness) doc.freshness = a.freshness;
  doc.provenance = a.provenance;
  doc.indexing = a.indexing;
  if (a.relationships.length > 0) doc.relationships = a.relationships;
  if (a.grants.length > 0) doc.grants = a.grants;
  return yaml.dump(doc, { lineWidth: 100, noRefs: true });
}

/** A fresh file envelope from the minimum upload inputs (everything else defaults). */
export function emptyAsset(input: {
  id: string;
  name: string;
  owner: string;
  domain: string;
  folder?: string;
  tags?: string[];
  sensitivity?: Sensitivity;
  storage?: Storage;
  provenanceSource?: ProvenanceSource;
  sourceUri?: string;
  at?: string;
}): FileAsset {
  const at = input.at ?? new Date().toISOString();
  const kind = fileKindFromName(input.name);
  const sensitivity = input.sensitivity ?? 'internal';
  const storage = input.storage ?? 'object-store';
  const base: FileAsset = {
    schemaVersion: '1',
    id: input.id,
    name: input.name,
    owner: input.owner,
    domain: input.domain,
    tier: 'dataset',
    visibility: 'private',
    description: '',
    assetType: assetTypeFor(kind),
    kind,
    folder: normaliseFolder(input.folder),
    tags: (input.tags ?? []).map((t) => t.trim()).filter(Boolean),
    sensitivity,
    freshness: at,
    version: 'v1',
    deepLink: input.sourceUri ?? '',
    provenance: { source: input.provenanceSource ?? 'upload', sourceUri: input.sourceUri, addedBy: input.owner, addedAt: at },
    relationships: [],
    storage,
    indexing: emptyIndexing(indexingModeFor(sensitivity)),
    grants: [],
  };
  if (storage === 'object-store') base.deepLink = deepLinkFor(base);
  return base;
}
