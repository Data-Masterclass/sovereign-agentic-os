/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { Sensitivity, Storage } from './asset-schema.ts';

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
 * Pure module: the sync LOGIC + the in-process sync-state live here (testable with
 * a mock client + a fake sink); the live Drive/OneDrive clients + the store-backed
 * sink + the Dagster trigger live in the server modules.
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
  /** The tier files land at (re-governed under OUR model). Default private dataset. */
  landingSensitivity: Sensitivity;
  /** Delta cursor for incremental pulls (null until the first sync). */
  cursor: string | null;
  /** Whether the first (overnight) pass has run. */
  initialDone: boolean;
  createdAt: string;
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

const sources = new Map<string, ConnectorSource>();

export function __resetConnectors(): void {
  sources.clear();
}

function id(): string {
  return `src_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;
}

export function addSource(input: {
  provider: Provider; label: string; scope: SyncScope; target: string; mode: SyncMode;
  owner: string; domain: string; landingSensitivity?: Sensitivity;
}): ConnectorSource {
  const src: ConnectorSource = {
    id: id(),
    provider: input.provider,
    label: input.label,
    scope: input.scope,
    target: input.target,
    mode: input.mode,
    owner: input.owner,
    domain: input.domain,
    landingSensitivity: input.landingSensitivity ?? 'internal',
    cursor: null,
    initialDone: false,
    createdAt: new Date().toISOString(),
  };
  sources.set(src.id, src);
  return src;
}

export function listSources(owner?: string): ConnectorSource[] {
  return [...sources.values()]
    .filter((s) => (owner ? s.owner === owner : true))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function getSource(sourceId: string): ConnectorSource | null {
  return sources.get(sourceId) ?? null;
}

export function removeSource(sourceId: string, owner: string): boolean {
  const s = sources.get(sourceId);
  if (!s || s.owner !== owner) return false;
  return sources.delete(sourceId);
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
  for (const file of items) {
    const outcome = await sink.upsert(file, source);
    if (outcome === 'added') added++;
    else if (outcome === 'updated') updated++;
    else unchanged++;
  }
  source.cursor = cursor;
  source.initialDone = true;
  sources.set(source.id, source);
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
