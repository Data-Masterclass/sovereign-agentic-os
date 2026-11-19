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
} from '@tabs/data/lib/index';

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

/**
 * WHY a file is `stored-only`. The mode alone cannot tell "the owner / the policy said never
 * index this" from "there was simply no text to index" — and only the second may ever be sent to
 * the parser again (the backfill, the per-file "Extract text").
 *   restricted — sensitivity clamp (decision #7). Never parsed, never indexed.
 *   opt-out    — the owner chose stored-only. Never parsed, never indexed.
 *   no-text    — nothing indexable was available: a binary whose text extraction has not
 *                succeeded (yet). Recoverable; see `extraction` for the specific reason.
 * ABSENT on files created before 2026-11-19 — `extractionEligibility` (extract.ts) applies a
 * documented heuristic to those.
 */
export type StoredOnlyReason = 'restricted' | 'opt-out' | 'no-text';
const STORED_ONLY_REASONS: StoredOnlyReason[] = ['restricted', 'opt-out', 'no-text'];

/** A typed reason text extraction did not produce text. Never a stand-in for the text itself. */
export type ExtractionFailureCode =
  | 'parser-unreachable' // no answer from the parser (connection refused / DNS / 5xx)
  | 'parser-timeout'     // the conversion did not finish inside the deadline
  | 'parser-error'       // the parser answered and reported a failure for this document
  | 'no-text'            // the parser succeeded and found no text (e.g. a scan OCR read nothing from)
  | 'bytes-missing'      // the original object is not in the object store
  | 'unsupported'        // not a format the parser accepts
  | 'interrupted';       // a background extraction did not report back (process replaced)

/**
 * The state of BINARY text extraction for this file (PDF/DOCX/PPTX/XLSX → Docling → markdown).
 * Absent for text-like files (their bytes ARE the text) and for files that were never parsed.
 */
export type Extraction = {
  status: 'extracted' | 'pending' | 'failed';
  /** The parser that ran (or was asked). */
  engine: 'docling';
  /** When this state was recorded (ISO). */
  at: string;
  /** Set only when `failed`. */
  code?: ExtractionFailureCode;
  /** One human sentence, shown next to "Stored only" — why, specifically. */
  reason?: string;
  /** Characters of extracted text (when `extracted`). */
  chars?: number;
};

/**
 * AUTOMATIC DESCRIPTION + TAGS (2026-11-19). One model call writes a short description and a
 * few tags from a file's text; this block records the state of that work and, per field, WHO
 * wrote what is on the file — because a user's own words always win and must never be replaced.
 *
 * `generation` reuses the extraction's bookkeeping style: pending / done / failed-with-reason,
 * plus `skipped` when the model was deliberately not called. Never a stand-in for the text.
 */
export type AutoDocsCode =
  | 'model-unreachable' // no answer from the gateway (connection refused / timeout / 5xx)
  | 'model-rejected'    // the gateway refused this call (key, allowlist, bad request)
  | 'budget'            // a spend cap or the key's budget is used up
  | 'not-configured'    // no scoped key, or the standard model role points at the mock
  | 'bad-output'        // the model answered, twice, with something that is not a usable result
  | 'interrupted'       // a background run did not report back (process replaced)
  | 'no-text'           // skipped: there is no text to describe
  | 'nothing-to-write'  // skipped: both fields are the user's own
  | 'disabled';         // skipped: switched off by the platform admin

export type AutoDocsGeneration = {
  status: 'pending' | 'done' | 'failed' | 'skipped';
  /** When this state was recorded (ISO). */
  at: string;
  /** Set when `failed` or `skipped`. */
  code?: AutoDocsCode;
  /** One human sentence, shown in Details. */
  reason?: string;
};

/** Who wrote a field. `model` + `at` are set for `generated`. */
export type DocsProvenance = { source: 'user' | 'generated'; model?: string; at?: string };

export type AutoDocs = {
  generation?: AutoDocsGeneration;
  /** Provenance of `description`. Absent = never recorded (a non-empty one is then the user's). */
  description?: DocsProvenance;
  /** Provenance of `tags`, per tag: a tag listed in `generated` was written by the model, every
   *  other tag is the user's. `removed` are generated tags a user took off — they never return,
   *  and once it is non-empty generation no longer touches the tags of this file. */
  tags?: { generated: string[]; model?: string; at?: string; removed?: string[] };
};

/** The retrieval side of the envelope (filled by the Phase-3 ingest pipeline). */
export type Indexing = {
  mode: IndexingMode;
  /** Which representations exist (text / transcript / caption / table). */
  representations: string[];
  /** Per-chunk content hashes — the content-hash cache that skips re-embeds. */
  chunkHashes: string[];
  /** Why the file is stored-only (absent when indexed, and on pre-2026-11-19 records). */
  storedOnlyReason?: StoredOnlyReason;
  /** Binary text-extraction state (absent when the file never went to the parser). */
  extraction?: Extraction;
  /** What the LAST index run did (absent = no run has been recorded for this file). The
   *  "Searchable" chip is read from this, never from `mode` alone: `mode` says the file MAY be
   *  indexed, the outcome says whether its index rows were really written. */
  outcome?: IndexOutcome;
};

/**
 * The recorded result of one index run. `indexed` = its chunks were written; `empty` = the run
 * produced nothing to index; `failed` = the run threw (parser or embeddings gateway), with why.
 */
export type IndexOutcome = {
  status: 'indexed' | 'empty' | 'failed';
  at: string;
  /** Chunks written (only on `indexed`). */
  chunks?: number;
  /** Why it failed (only on `failed`). */
  reason?: string;
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
  /** Automatic description + tags: generation state and per-field provenance. Absent on files
   *  nothing was ever generated for and nobody edited since 2026-11-19. */
  autoDocs?: AutoDocs;
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

const EXTRACTION_CODES: ExtractionFailureCode[] = [
  'parser-unreachable', 'parser-timeout', 'parser-error', 'no-text', 'bytes-missing', 'unsupported', 'interrupted',
];

function parseExtraction(v: unknown): Extraction | undefined {
  if (!isRecord(v)) return undefined;
  const status = v.status;
  if (status !== 'extracted' && status !== 'pending' && status !== 'failed') return undefined;
  const out: Extraction = { status, engine: 'docling', at: typeof v.at === 'string' ? v.at : '' };
  if (EXTRACTION_CODES.includes(v.code as ExtractionFailureCode)) out.code = v.code as ExtractionFailureCode;
  if (typeof v.reason === 'string' && v.reason) out.reason = v.reason;
  if (typeof v.chars === 'number') out.chars = v.chars;
  return out;
}

const AUTO_DOCS_CODES: AutoDocsCode[] = [
  'model-unreachable', 'model-rejected', 'budget', 'not-configured', 'bad-output', 'interrupted',
  'no-text', 'nothing-to-write', 'disabled',
];

function parseProvenanceOf(v: unknown): DocsProvenance | undefined {
  if (!isRecord(v) || (v.source !== 'user' && v.source !== 'generated')) return undefined;
  const out: DocsProvenance = { source: v.source };
  if (typeof v.model === 'string' && v.model) out.model = v.model;
  if (typeof v.at === 'string' && v.at) out.at = v.at;
  return out;
}

function parseAutoDocs(v: unknown, tags: string[]): AutoDocs | undefined {
  if (!isRecord(v)) return undefined;
  const out: AutoDocs = {};
  const g = v.generation;
  if (isRecord(g) && (g.status === 'pending' || g.status === 'done' || g.status === 'failed' || g.status === 'skipped')) {
    out.generation = { status: g.status, at: typeof g.at === 'string' ? g.at : '' };
    if (AUTO_DOCS_CODES.includes(g.code as AutoDocsCode)) out.generation.code = g.code as AutoDocsCode;
    if (typeof g.reason === 'string' && g.reason) out.generation.reason = g.reason;
  }
  const description = parseProvenanceOf(v.description);
  if (description) out.description = description;
  if (isRecord(v.tags)) {
    // A tag can only be "generated" while it is still on the file.
    const generated = strArray(v.tags.generated, 'autoDocs.tags.generated').filter((t) => tags.includes(t));
    const removed = strArray(v.tags.removed, 'autoDocs.tags.removed').filter(Boolean);
    if (generated.length > 0 || removed.length > 0) {
      out.tags = { generated };
      if (typeof v.tags.model === 'string' && v.tags.model) out.tags.model = v.tags.model;
      if (typeof v.tags.at === 'string' && v.tags.at) out.tags.at = v.tags.at;
      if (removed.length > 0) out.tags.removed = removed;
    }
  }
  return out.generation || out.description || out.tags ? out : undefined;
}

function parseOutcome(v: unknown): IndexOutcome | undefined {
  if (!isRecord(v)) return undefined;
  if (v.status !== 'indexed' && v.status !== 'empty' && v.status !== 'failed') return undefined;
  const out: IndexOutcome = { status: v.status, at: typeof v.at === 'string' ? v.at : '' };
  if (typeof v.chunks === 'number') out.chunks = v.chunks;
  if (typeof v.reason === 'string' && v.reason) out.reason = v.reason;
  return out;
}

function parseIndexing(v: unknown, sensitivity: Sensitivity): Indexing {
  const r = isRecord(v) ? v : {};
  const requested = (r.mode === 'stored-only' ? 'stored-only' : 'indexed') as IndexingMode;
  // The restricted ⇒ stored-only invariant is enforced HERE, in one place.
  const mode = indexingModeFor(sensitivity, requested);
  const out: Indexing = {
    mode,
    representations: strArray(r.representations, 'indexing.representations'),
    chunkHashes: strArray(r.chunkHashes, 'indexing.chunkHashes'),
  };
  // The reason is only meaningful while stored-only, and `restricted` always wins.
  if (mode === 'stored-only') {
    if (sensitivity === 'restricted') out.storedOnlyReason = 'restricted';
    else if (STORED_ONLY_REASONS.includes(r.storedOnlyReason as StoredOnlyReason) && r.storedOnlyReason !== 'restricted') {
      out.storedOnlyReason = r.storedOnlyReason as StoredOnlyReason;
    }
  }
  const extraction = parseExtraction(r.extraction);
  if (extraction) out.extraction = extraction;
  const outcome = parseOutcome(r.outcome);
  if (outcome) out.outcome = outcome;
  return out;
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
  const autoDocs = parseAutoDocs(doc.autoDocs, asset.tags);
  if (autoDocs) asset.autoDocs = autoDocs;
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
  // Built explicitly: js-yaml refuses an `undefined` value, and the two optional fields below
  // are cleared by assignment in the store.
  const indexing: Record<string, unknown> = {
    mode: a.indexing.mode,
    representations: a.indexing.representations,
    chunkHashes: a.indexing.chunkHashes,
  };
  if (a.indexing.mode === 'stored-only' && a.indexing.storedOnlyReason) indexing.storedOnlyReason = a.indexing.storedOnlyReason;
  if (a.indexing.extraction) {
    indexing.extraction = Object.fromEntries(Object.entries(a.indexing.extraction).filter(([, v]) => v !== undefined));
  }
  if (a.indexing.outcome) {
    indexing.outcome = Object.fromEntries(Object.entries(a.indexing.outcome).filter(([, v]) => v !== undefined));
  }
  doc.indexing = indexing;
  if (a.relationships.length > 0) doc.relationships = a.relationships;
  if (a.grants.length > 0) doc.grants = a.grants;
  // JSON round-trip drops every `undefined` (js-yaml refuses one) without listing the fields.
  if (a.autoDocs && (a.autoDocs.generation || a.autoDocs.description || a.autoDocs.tags)) {
    doc.autoDocs = JSON.parse(JSON.stringify(a.autoDocs));
  }
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
