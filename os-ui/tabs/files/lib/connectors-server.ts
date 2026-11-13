/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import {
  type ConnectorSource,
  type RemoteFile,
  type SyncSink,
  type SyncResult,
  type UpsertOutcome,
  getSource,
  runSync,
} from '@tabs/files/lib/connectors';
import { liveClientFor } from '@tabs/files/lib/connectors-live';
import { createFile, addVersion, type Principal } from '@tabs/files/lib/store';
import { reindexById, reindexFile } from '@tabs/files/lib/pipeline-server';

/**
 * Server boundary for connected-drive sync. Builds a store-backed sink that
 * RE-GOVERNS each remote file under OUR tiers (lands it at the source's owner /
 * domain / sensitivity, private by default — NOT the source ACLs), honours
 * copy-into-store vs index-in-place, and auto-indexes it. Detects change by content
 * hash (an unchanged file is skipped — never re-imported or re-embedded). The
 * overnight first pass + live-incremental cadence are driven by Dagster
 * (best-effort trigger; the sync still runs in-process so kind works offline).
 */

// (source.id : remoteId) -> the imported file + its last seen remote hash. The
// import ledger that powers the incremental skip across syncs.
const ledger = new Map<string, { fileId: string; hash: string }>();

function principalFor(source: ConnectorSource): Principal {
  return { id: source.owner, domains: [source.domain], role: 'creator' };
}

function makeStoreSink(source: ConnectorSource): SyncSink {
  const principal = principalFor(source);
  return {
    async upsert(file: RemoteFile, src: ConnectorSource): Promise<UpsertOutcome> {
      const key = `${src.id}:${file.remoteId}`;
      const prev = ledger.get(key);
      if (prev && prev.hash === file.contentHash) return 'unchanged'; // content-hash skip
      if (prev) {
        addVersion(prev.fileId, principal, { text: file.text, bytes: file.text?.length });
        ledger.set(key, { fileId: prev.fileId, hash: file.contentHash });
        await reindexById(prev.fileId);
        return 'updated';
      }
      const asset = createFile(principal, {
        name: file.name,
        folder: file.path,
        text: file.text,
        bytes: file.text?.length,
        sensitivity: src.landingSensitivity,
        storage: src.mode === 'copy' ? 'object-store' : 'in-place',
        sourceUri: file.url,
        provenanceSource: src.provider,
        domain: src.domain,
      });
      ledger.set(key, { fileId: asset.id, hash: file.contentHash });
      await reindexFile(asset, file.text ?? '');
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
 * TODO (B3/B4): define the external-source asset `files__<source>` in the `sovereign` location and
 * launch it here through `core/infra/dagster.ts` `launchRun`, as the connector's owner principal.
 */
function triggerDagster(source: ConnectorSource, cadence: string): false {
  console.info(`[files] connector sync ${source.id} (${cadence}) ran in-process — the Dagster 'sovereign' location defines no job for Files connectors yet (engine rebuild B3/B4)`);
  return false;
}

/**
 * Run a sync for a source. `token` is the connection's OAuth Read token (null →
 * the mock client / kind). The first pass is the overnight batch; later passes are
 * incremental. Returns the tally + the cadence + whether the run was live or mock.
 */
export async function runConnectorSync(sourceId: string, owner: string, token: string | null): Promise<SyncResult> {
  const source = getSource(sourceId);
  if (!source) {
    const err = new Error('Connected source not found');
    (err as Error & { status?: number }).status = 404;
    throw err;
  }
  if (source.owner !== owner) {
    const err = new Error('Not permitted to sync this source');
    (err as Error & { status?: number }).status = 403;
    throw err;
  }
  const client = liveClientFor(source.provider, token);
  triggerDagster(source, source.initialDone ? 'incremental' : 'overnight');
  return runSync(source, client, makeStoreSink(source));
}
