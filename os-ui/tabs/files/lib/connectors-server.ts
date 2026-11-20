/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import {
  type ConnectorSource,
  type ConnectorClient,
  type RemoteFile,
  type SyncSink,
  type SyncResult,
  type UpsertOutcome,
  type Provider,
  getSource,
  runSync,
  ensureSourcesHydrated,
  requireSourcesLoaded,
  saveSource,
  addSource,
  listSources,
  removeSource,
} from '@tabs/files/lib/connectors';
import { liveClientFor } from '@tabs/files/lib/connectors-live';
import { createHash } from 'node:crypto';
import { createFile, addVersion, attachObject, objectKeyForAsset, fileExists, type Principal } from '@tabs/files/lib/store';
import { putBlob } from '@tabs/files/lib/object-store';
import '@tabs/files/lib/object-store-server'; // registers the durable object-store backend
import { reindexById, reindexFile, ingestUploaded } from '@tabs/files/lib/pipeline-server';
import type { FileAsset } from '@tabs/files/lib/asset-schema';

/**
 * Server boundary for connected-drive sync. Builds a store-backed sink that
 * RE-GOVERNS each remote file under OUR tiers (lands it at the source's owner /
 * domain / sensitivity, private by default — NOT the source ACLs), honours
 * copy-into-store vs index-in-place, and auto-indexes it. Detects change by content
 * hash (an unchanged file is skipped — never re-imported or re-embedded). The
 * overnight first pass + live-incremental cadence are driven by Dagster
 * (best-effort trigger; the sync still runs in-process so kind works offline).
 */

function principalFor(source: ConnectorSource): Principal {
  return { id: source.owner, domains: [source.domain], role: 'creator' };
}

/** A text-like file's bytes ARE its text (the same rule as the upload route); a binary document's
 *  text is read from the stored bytes by Docling (`ingestUploaded`). */
export function isTextLikeFile(name: string, type: string): boolean {
  return /^text\//.test(type) || /json|csv|xml|markdown|yaml/.test(type) || /\.(txt|md|csv|tsv|json|log|xml|yaml|yml)$/i.test(name);
}

/** One remote item → one Files id, derived from the source and the provider's item id (Graph
 *  driveItem id). A sync interrupted between creating a file and recording it finds the file on
 *  the next run instead of importing it twice. */
export function importedFileId(sourceId: string, remoteId: string): string {
  return `as_${createHash('sha256').update(`${sourceId}\u0000${remoteId}`).digest('hex').slice(0, 24)}`;
}

function makeStoreSink(source: ConnectorSource, client: ConnectorClient): SyncSink {
  const principal = principalFor(source);
  // COPY-IN with a client that can read bytes: the file's real content is stored and goes through
  // the upload pipeline (Docling for binaries, then embeddings), as the OWNER. Otherwise only the
  // reference is indexed (index-in-place, or a client without a content read).
  const copyContent = source.mode === 'copy' && typeof client.content === 'function';
  // The content is read BEFORE anything is written, so a refused read leaves no half-imported file:
  // a new file is simply not created (the next sync tries again), an update keeps its old version.
  async function readContent(file: RemoteFile): Promise<{ bytes: Buffer; contentType: string; text: string } | null> {
    if (!copyContent) return null;
    const { bytes, contentType } = await client.content!(file);
    return { bytes, contentType, text: isTextLikeFile(file.name, contentType) ? bytes.toString('utf8') : '' };
  }
  async function store(asset: FileAsset, c: { bytes: Buffer; contentType: string; text: string }): Promise<void> {
    const key = objectKeyForAsset(asset);
    if (key) {
      await putBlob(key, c.bytes, c.contentType);
      attachObject(asset.id, principal, { contentType: c.contentType, bytes: c.bytes.length });
    }
    await ingestUploaded(asset, c.text, source.owner); // Docling for binaries, then embeddings — billed to the owner
  }
  return {
    async upsert(file: RemoteFile, src: ConnectorSource): Promise<UpsertOutcome> {
      // The import ledger lives ON the (persisted) source, so it survives a restart.
      const ledger = (src.imported ??= {});
      const fileId = importedFileId(src.id, file.remoteId);
      // The ledger, or — after a crash before the ledger was written — the deterministic file itself.
      const prev = ledger[file.remoteId] ?? (fileExists(fileId) ? { fileId, hash: '' } : undefined);
      if (prev && prev.hash === file.contentHash) return 'unchanged'; // same item, same content hash (quickXorHash / eTag)
      const content = await readContent(file);
      const text = content ? content.text : file.text;
      const bytes = content ? content.bytes.length : file.text?.length;
      if (prev) {
        const asset = addVersion(prev.fileId, principal, { text, bytes });
        if (content) await store(asset, content);
        else await reindexById(prev.fileId);
        ledger[file.remoteId] = { fileId: prev.fileId, hash: file.contentHash };
        saveSource(src); // the ledger is durable per file, not only at the end of the run
        return 'updated';
      }
      const asset = createFile(principal, {
        id: fileId,
        name: file.name,
        folder: file.path,
        text,
        bytes,
        sensitivity: src.landingSensitivity,
        storage: src.mode === 'copy' ? 'object-store' : 'in-place',
        sourceUri: file.url,
        provenanceSource: src.provider,
        domain: src.domain,
      });
      ledger[file.remoteId] = { fileId: asset.id, hash: '' }; // recorded now; current once its content landed
      saveSource(src);
      if (content) await store(asset, content);
      else await reindexFile(asset, file.text ?? '');
      ledger[file.remoteId] = { fileId: asset.id, hash: file.contentHash };
      saveSource(src);
      return 'added';
    },
  };
}

/**
 * Dagster labelling for the (overnight) connector sync. The `sovereign` code location defines NO
 * job for the Files connectors — they are not dbt models, and the concept lists an API-batch source
 * as a Dagster external asset, which is B3/B4 work (`os/external.yml` already records them).
 *
 * So this is a LOGGED NO-OP, not a fake trigger: the old call fired
 * `launchPipelineExecution(pipelineName: 'files_connector_sync')` against a job that has never
 * existed — Dagster answered with an error union the code discarded and then reported `live` from
 * `res.ok` (HTTP 200 with a GraphQL error body). The in-process sync is the real executor either
 * way; it runs below regardless.
 *
 * FLAG-IRRESPECTIVE, deliberately (review B2-review-M6c): this is a no-op with `DATA_PROJECT_GIT`
 * off as well as on, because the job it used to "launch" never existed in EITHER state — the old
 * call reported `live` from an HTTP 200 whose body was a GraphQL error. Restoring that would
 * restore a lie, so the honest no-op stands for both.
 *
 * TODO (B3/B4): define the external-source asset `files__<source>` in the `sovereign` location and
 * launch it here through `core/infra/dagster.ts` `launchRun`, as the connector's owner principal.
 *
 * @returns always false — "no Dagster run was launched" — in the `live` shape the caller records.
 */
function triggerDagster(source: ConnectorSource, cadence: string): boolean {
  console.info(`[files] connector sync ${source.id} (${cadence}) ran in-process — the Dagster 'sovereign' location defines no job for Files connectors yet (engine rebuild B3/B4)`);
  return false;
}

/** What a sync needs to know about its owner NOW, on every run (wired by the routes: the live
 *  principal from `core/kernel/auth.ts` and the token from the owner's Connection). */
export type SyncEntitlement = {
  /** The owner as they are now — null when deactivated or gone (`principalById`). */
  liveOwner: (userId: string) => Promise<{ domains: string[] } | null>;
  /** The linked connection's Read token. Throws 403/404 when the owner no longer holds the drive
   *  grant (the connection was deleted, or is no longer theirs); null when it needs a reconnect. */
  token: () => Promise<string | null>;
};

function refusal(message: string, status: number, code: string): Error {
  return Object.assign(new Error(message), { status, code });
}

/** Stop and pause the source with the reason, durably; the error says why. */
function pause(source: ConnectorSource, reason: string): never {
  source.paused = { reason, at: new Date().toISOString() };
  saveSource(source);
  throw refusal(`Sync paused: ${reason}. Nothing was read from the drive.`, 403, 'source_paused');
}

/**
 * Run a sync for a source, as its owner. EVERY run — a click, or a scheduled pass that has no
 * session — re-checks the owner live first: deactivated, no longer in the source's domain, or no
 * longer holding the drive grant ⇒ the source is paused and nothing is read. A run by an entitled
 * owner lifts an earlier pause. The first pass is the overnight batch; later passes are incremental.
 */
export async function runConnectorSync(sourceId: string, owner: string, ent: SyncEntitlement): Promise<SyncResult> {
  await requireSourcesLoaded();
  const source = getSource(sourceId);
  if (!source) throw refusal('Connected source not found', 404, 'not_found');
  if (source.owner !== owner) throw refusal('Not permitted to sync this source', 403, 'forbidden');
  const live = await ent.liveOwner(source.owner);
  if (!live) pause(source, 'the owner is deactivated');
  if (!live.domains.includes(source.domain)) pause(source, `the owner is no longer a member of ${source.domain}`);
  let token: string | null;
  try {
    token = await ent.token();
  } catch (e) {
    const st = (e as { status?: number }).status;
    if (st === 403 || st === 404) pause(source, 'the owner no longer holds the drive connection');
    throw e;
  }
  const client = liveClientFor(source.provider, token);
  triggerDagster(source, source.initialDone ? 'incremental' : 'overnight');
  return runSync(source, client, makeStoreSink(source, client));
}

/**
 * Index a whole connected drive into Files for its owner: reuse the source already linked to the
 * connection or register one, then sync it now with the connection's OAuth Read token. A failed
 * FIRST sync leaves no source behind; a provider refusal propagates (the live client refuses
 * rather than substituting placeholder files). Called by the Connections "Index → Files" route.
 */
export async function indexDriveSource(input: {
  connectionId: string; provider: Provider; label: string; owner: string; domain: string; token: string;
}, deps: Pick<SyncEntitlement, 'liveOwner'>): Promise<{ sourceId: string; records: number; mode: 'live' | 'mock' }> {
  await requireSourcesLoaded();
  const existing = listSources(input.owner).find((s) => s.connectionId === input.connectionId && s.provider === input.provider);
  const source = existing ?? addSource({
    provider: input.provider, label: input.label, scope: 'drive', target: 'root', mode: 'copy',
    owner: input.owner, domain: input.domain, connectionId: input.connectionId,
  });
  try {
    const r = await runConnectorSync(source.id, input.owner, { liveOwner: deps.liveOwner, token: async () => input.token });
    return { sourceId: source.id, records: r.added + r.updated + r.unchanged, mode: r.clientMode };
  } catch (e) {
    if (!existing) removeSource(source.id, input.owner);
    throw e;
  }
}
