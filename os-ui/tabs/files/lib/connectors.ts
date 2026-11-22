/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { Sensitivity, Storage } from '@tabs/files/lib/asset-schema';
import { osMirror } from '@core/infra/os-mirror';
import { newSeenFields, noteSeen, writeChanged, writeDeleted, writeNew, type SeenFields } from '@core/infra/field-writes';
import type { SyncRunRecord } from '@tabs/files/lib/drive-sync-health';

/**
 * Connected drives (handover §provisioning). A user connects a source — Google
 * Drive or OneDrive — via the Connections tab (a governed OAuth **Read** profile),
 * and adds a **folder or the whole drive**. Files sync into the governed store and
 * are auto-indexed. Two locked choices per source:
 *   • copy-into-store  → bytes land in OUR object store (sovereign, offline-capable)
 *   • index-in-place   → files stay in the drive; we index a REFERENCE + fetch on demand
 * Permissions are RE-GOVERNED under our tiers (the connector lands files at a chosen
 * domain/tier; access follows private/domain/marketplace, NOT the source ACLs).
 *
 * Cadence: the first/large pull runs OVERNIGHT (batched via Dagster); thereafter a
 * LIVE-INCREMENTAL pull on change keeps it fresh — detected by content hash so an
 * unchanged file is never re-imported or re-embedded.
 *
 * The sync LOGIC + the sync-state live here (testable with a mock client + a fake sink); the
 * live Drive/OneDrive clients + the store-backed sink + the Dagster trigger live in the server
 * modules. DURABILITY: every source (with its delta cursor and import ledger) is written through
 * to the OpenSearch mirror `os-files-sources` and hydrated on first use, the way the other
 * stores do (`core/infra/os-mirror.ts`): only a COMPLETE read of the index is taken as the
 * store's contents; a failed or partial read leaves the store un-hydrated and is retried.
 */

export type Provider = 'google-drive' | 'onedrive';
export type SyncScope = 'folder' | 'drive';

/** The Read connector profiles offered in the Sources panel (handover: Drive/
 *  OneDrive via Connections, a governed OAuth Read capability). */
export type ConnectorTemplate = { provider: Provider; label: string; detail: string; capability: 'Read'; scopes: SyncScope[] };
export const CONNECTOR_TEMPLATES: ConnectorTemplate[] = [
  { provider: 'google-drive', label: 'Google Drive', detail: 'Docs, PDFs, images, sheets', capability: 'Read', scopes: ['folder', 'drive'] },
  { provider: 'onedrive', label: 'OneDrive', detail: 'Microsoft 365 files & folders', capability: 'Read', scopes: ['folder', 'drive'] },
];
export type SyncMode = 'copy' | 'reference';
export type Cadence = 'overnight' | 'incremental';

export type ConnectorSource = {
  id: string;
  provider: Provider;
  /** Display label (the folder/drive name). */
  label: string;
  scope: SyncScope;
  /** The remote folder id / drive id this source covers. */
  target: string;
  mode: SyncMode;
  owner: string;
  domain: string;
  /** The governed Connection (Connections tab) whose OAuth Read token this source
   *  syncs with. Null → no linked connection → the sync uses the mock fake-drive. */
  connectionId: string | null;
  /** The tier files land at (re-governed under OUR model). Default private dataset. */
  landingSensitivity: Sensitivity;
  /** Delta cursor for incremental pulls (null until the first sync). */
  cursor: string | null;
  /** Whether the first (overnight) pass has run. */
  initialDone: boolean;
  createdAt: string;
  /** The import ledger: remote file id → the Files asset it became + its last seen hash. Drives
   *  the incremental skip, and keeps a re-sync after a restart from importing a file twice. */
  imported?: Record<string, { fileId: string; hash: string }>;
  /** Set when a sync found the owner no longer entitled (deactivated, left the domain, lost the
   *  drive grant). A paused source does not sync; a sync by an entitled owner lifts it. */
  paused?: { reason: string; at: string } | null;
  /** The last N sync runs (newest last) — time, trigger, counts, error text, duration. Bounded by
   *  `MAX_SYNC_RUNS`; kept on the record so it is mirrored to the same store, no new database. */
  runs?: SyncRunRecord[];
  /** Owner-alert incidents already sent (kind → incident id), so each is sent once. */
  alerts?: Record<string, string>;
};

/** A file as seen in the remote drive (what a client's pull returns). */
export type RemoteFile = {
  remoteId: string;
  name: string;
  /** Folder path inside the source (we mirror it as our folder). */
  path: string;
  mimeType: string;
  modifiedAt: string;
  /** Content hash from the provider (drives the incremental skip). */
  contentHash: string;
  /** The canonical remote deep-link (used as the in-place reference). */
  url: string;
  /** Extracted/preview text (mock clients provide it; live ones fetch on copy). */
  text?: string;
};

export type Pull = { items: RemoteFile[]; cursor: string };

/** A connector client pulls changes since a cursor. Mock + live share this shape. */
export interface ConnectorClient {
  provider: Provider;
  mode: 'live' | 'mock';
  pull(source: ConnectorSource, sinceCursor: string | null): Promise<Pull>;
  /** The file's BYTES, read with the owner's token (live clients that support a copy-in only).
   *  Throws when the provider does not answer with the content — never returns a stand-in. */
  content?(file: RemoteFile): Promise<{ bytes: Buffer; contentType: string }>;
}

/** What the store-backed sink reports per remote file (the re-govern + index step). */
export type UpsertOutcome = 'added' | 'updated' | 'unchanged';

/** The sink the sync applies changes through (store-backed in the server; a fake in
 *  tests). It owns the re-govern + copy-vs-reference + (re)index decisions. */
export interface SyncSink {
  upsert(file: RemoteFile, source: ConnectorSource): Promise<UpsertOutcome> | UpsertOutcome;
}

export type SyncResult = {
  sourceId: string;
  cadence: Cadence;
  clientMode: 'live' | 'mock';
  added: number;
  updated: number;
  unchanged: number;
  cursor: string;
};

// ----------------------------------------------------------- sync-state store --

type SourcesState = {
  sources: Map<string, ConnectorSource>;
  /** Per source, the fields the mirror holds as far as this process knows (`field-writes.ts`). */
  seen: SeenFields;
  hydration: Promise<void> | null;
  hydratedAt?: number;
  hydrateFailedAt?: number;
};
const CONN_SOURCES_KEY = Symbol.for('soa.files.connectors.state');
function sourcesState(): SourcesState {
  const g = globalThis as unknown as Record<symbol, SourcesState | undefined>;
  if (!g[CONN_SOURCES_KEY]) g[CONN_SOURCES_KEY] = { sources: new Map(), seen: newSeenFields(), hydration: null };
  return g[CONN_SOURCES_KEY]!;
}
function connSources(): Map<string, ConnectorSource> {
  return sourcesState().sources;
}

// The ledger keys are remote ids (unbounded), so the index maps only what it filters on and
// stores the rest as `_source` (dynamic: false) — no field explosion from a large drive.
const mirror = osMirror({
  index: 'os-files-sources',
  createBody: {
    mappings: {
      dynamic: false,
      properties: { id: { type: 'keyword' }, owner: { type: 'keyword' }, connectionId: { type: 'keyword' }, provider: { type: 'keyword' } },
    },
  },
});
/** A source is written as the fields that changed (the ledger, the run history and the pause each go as
 *  their own partial update) — a whole-record PUT per save raced with the next one and a late older copy
 *  could erase the run just recorded. A source this process has not stored yet goes whole. */
function persist(src: ConnectorSource): void {
  const s = sourcesState();
  const doc = src as unknown as Record<string, unknown>;
  if (s.seen.has(src.id)) writeChanged(mirror, s.seen, src.id, doc);
  else writeNew(mirror, s.seen, src.id, doc);
}

/** Load the sources once from the mirror. Only a complete read counts; a failed read stays
 *  un-hydrated (recorded) so the next call retries — never cached as "empty". */
export async function ensureSourcesHydrated(): Promise<void> {
  const s = sourcesState();
  if (s.hydratedAt !== undefined) return;
  if (!s.hydration) {
    s.hydration = (async () => {
      const docs = await mirror.hydrate(5000);
      if (docs === null) { s.hydrateFailedAt = Date.now(); return; }
      for (const d of docs as ConnectorSource[]) {
        if (d && d.id && !s.sources.has(d.id)) {
          s.sources.set(d.id, d);
          noteSeen(s.seen, d.id, d as unknown as Record<string, unknown>);
        }
      }
      s.hydratedAt = Date.now();
      delete s.hydrateFailedAt;
    })().finally(() => { s.hydration = null; });
  }
  await s.hydration;
}

/** The typed refusal while the sources could not be loaded: never an empty list, a re-add or a
 *  sync on a partial view (which would import a source's files a second time). */
export class SourcesNotLoadedError extends Error {
  readonly code = 'store_not_loaded';
  readonly status = 503;
  constructor() {
    super('Connected sources could not be loaded from the store yet — nothing was listed, added or synced. Retry shortly.');
    this.name = 'SourcesNotLoadedError';
  }
}

/** Hydrate, then refuse (typed, 503) unless the sources are loaded. Every route entry calls this. */
export async function requireSourcesLoaded(): Promise<void> {
  await ensureSourcesHydrated();
  if (sourcesHydrationState() === 'failed') throw new SourcesNotLoadedError();
}

/** Persist a source mid-sync (the ledger after each imported file). */
export function saveSource(src: ConnectorSource): void {
  connSources().set(src.id, src);
  persist(src);
}

export function sourcesHydrationState(): 'hydrated' | 'failed' | 'pending' {
  const s = sourcesState();
  if (s.hydratedAt !== undefined) return 'hydrated';
  return s.hydrateFailedAt !== undefined ? 'failed' : 'pending';
}

export function __resetConnectors(): void {
  const s = sourcesState();
  s.sources.clear();
  s.seen.clear();
  s.hydration = null;
  delete s.hydratedAt;
  delete s.hydrateFailedAt;
  mirror.__reset();
}

function id(): string {
  return `src_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;
}

export function addSource(input: {
  provider: Provider; label: string; scope: SyncScope; target: string; mode: SyncMode;
  owner: string; domain: string; connectionId?: string | null; landingSensitivity?: Sensitivity;
}): ConnectorSource {
  if (sourcesHydrationState() === 'failed') throw new SourcesNotLoadedError();
  const src: ConnectorSource = {
    id: id(),
    provider: input.provider,
    label: input.label,
    scope: input.scope,
    target: input.target,
    mode: input.mode,
    owner: input.owner,
    domain: input.domain,
    connectionId: input.connectionId ?? null,
    landingSensitivity: input.landingSensitivity ?? 'internal',
    cursor: null,
    initialDone: false,
    createdAt: new Date().toISOString(),
    imported: {},
  };
  connSources().set(src.id, src);
  persist(src);
  return src;
}

export function listSources(owner?: string): ConnectorSource[] {
  return [...connSources().values()]
    .filter((s) => (owner ? s.owner === owner : true))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function getSource(sourceId: string): ConnectorSource | null {
  return connSources().get(sourceId) ?? null;
}

export function removeSource(sourceId: string, owner: string): boolean {
  const s = connSources().get(sourceId);
  if (sourcesHydrationState() === 'failed') throw new SourcesNotLoadedError();
  if (!s || s.owner !== owner) return false;
  connSources().delete(sourceId);
  writeDeleted(mirror, sourcesState().seen, sourceId);
  return true;
}

/** The cadence the NEXT run uses: the first pass is the batched OVERNIGHT job; after
 *  that, live-incremental on change (handover). */
export function nextCadence(source: ConnectorSource): Cadence {
  return source.initialDone ? 'incremental' : 'overnight';
}

// ------------------------------------------------------------------- the sync --

/**
 * Run one sync of a source through a client + a sink. Pulls changes since the
 * cursor, applies each remote file via the sink (which re-governs + copies/refs +
 * indexes), tallies the outcomes, and advances the cursor + marks the initial pass
 * done. The content-hash skip lives in the sink (unchanged → 'unchanged').
 */
export async function runSync(source: ConnectorSource, client: ConnectorClient, sink: SyncSink): Promise<SyncResult> {
  const cadence = nextCadence(source);
  const { items, cursor } = await client.pull(source, source.cursor);
  let added = 0, updated = 0, unchanged = 0;
  try {
    for (const file of items) {
      const outcome = await sink.upsert(file, source);
      if (outcome === 'added') added++;
      else if (outcome === 'updated') updated++;
      else unchanged++;
    }
  } catch (e) {
    persist(source); // keep the ledger entries of files already imported; the cursor stays put
    throw e;
  }
  source.cursor = cursor;
  source.initialDone = true;
  source.paused = null;
  connSources().set(source.id, source);
  persist(source);
  return { sourceId: source.id, cadence, clientMode: client.mode, added, updated, unchanged, cursor };
}

// ----------------------------------------------------- the deterministic MOCK --

/** Per-provider fake drive (deterministic). The first pull returns the full set;
 *  a second pull returns ONE changed file (new hash) to demonstrate incremental. */
const MOCK_DRIVE: Record<Provider, RemoteFile[]> = {
  'google-drive': [
    { remoteId: 'gd-1', name: 'Q3-plan.pdf', path: '/Planning', mimeType: 'application/pdf', modifiedAt: '2026-06-20T09:00:00Z', contentHash: 'gd1aaaaa', url: 'https://drive.google.com/file/gd-1', text: 'The Q3 plan targets a twelve percent revenue increase across the sales domain.' },
    { remoteId: 'gd-2', name: 'logo-final.png', path: '/Brand', mimeType: 'image/png', modifiedAt: '2026-06-18T12:00:00Z', contentHash: 'gd2aaaaa', url: 'https://drive.google.com/file/gd-2', text: 'Caption: the refreshed company logo on white.' },
  ],
  onedrive: [
    { remoteId: 'od-1', name: 'budget.xlsx', path: '/Finance', mimeType: 'application/vnd.ms-excel', modifiedAt: '2026-06-19T08:00:00Z', contentHash: 'od1aaaaa', url: 'https://onedrive.com/od-1', text: 'Budget rows: marketing, sales, operations with quarterly allocations.' },
  ],
};

export function mockClient(provider: Provider): ConnectorClient {
  return {
    provider,
    mode: 'mock',
    async pull(_source, sinceCursor): Promise<Pull> {
      const base = MOCK_DRIVE[provider];
      if (!sinceCursor) return { items: base, cursor: 'cursor-1' };
      // Incremental: the first file comes back with a NEW hash (an edit upstream).
      const changed: RemoteFile = { ...base[0], contentHash: base[0].contentHash + '-v2', modifiedAt: '2026-06-30T10:00:00Z', text: (base[0].text ?? '') + ' (updated)' };
      return { items: [changed], cursor: `${sinceCursor}+1` };
    },
  };
}

// ------------------------------------------------- which connection a source uses --

/** A drive connection the caller could link a source to (from the Connections tab). */
export type SourceConnectionCandidate = { id: string; name: string; owner: string; provider: Provider };

function refuse(message: string, status: number): never {
  const e = new Error(message) as Error & { status?: number };
  e.status = status;
  throw e;
}

/**
 * Pick the governed Connection whose OAuth Read token a new source syncs with. A source must be
 * linked — without one its sync has no token and is refused — so:
 *   • `requested` must be one of the caller's OWN connections for this provider (403 otherwise);
 *   • none requested and exactly one such connection → that one;
 *   • none requested and several → 400 (the form asks which);
 *   • none at all → 409 "connect it in Connections first", unless `allowUnlinked` (the local
 *     teaching flow, `offlineMockAllowed()`), where an unlinked source syncs the fake drive.
 */
export function chooseSourceConnection(input: {
  provider: Provider; userId: string; requested?: string | null;
  candidates: SourceConnectionCandidate[]; allowUnlinked: boolean;
}): string | null {
  const own = input.candidates.filter((c) => c.owner === input.userId && c.provider === input.provider);
  const label = input.provider === 'onedrive' ? 'OneDrive' : 'Google Drive';
  if (input.requested) {
    if (!own.some((c) => c.id === input.requested)) refuse(`Choose one of your own ${label} connections`, 403);
    return input.requested;
  }
  if (own.length === 1) return own[0].id;
  if (own.length > 1) refuse(`You have ${own.length} ${label} connections — choose which one this source uses`, 400);
  if (input.allowUnlinked) return null;
  return refuse(`Connect your ${label} in Connections first — a source syncs with that connection's sign-in`, 409);
}
