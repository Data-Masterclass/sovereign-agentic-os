/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { config } from '@/lib/config';
import {
  type ConnectorSource,
  type RemoteFile,
  type SyncSink,
  type SyncResult,
  type UpsertOutcome,
  getSource,
  runSync,
} from '@/lib/files/connectors';
import { liveClientFor } from '@/lib/files/connectors-live';
import { createFile, addVersion, type Principal } from '@/lib/files/store';
import { reindexById, reindexFile } from '@/lib/files/pipeline-server';

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

export function __resetConnectorLedger(): void {
  ledger.clear();
}

function principalFor(source: ConnectorSource): Principal {
  return { id: source.owner, domains: [source.domain], role: 'participant' };
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

/** Best-effort Dagster trigger for the (overnight) sync job — labels the run; the
 *  in-process sync still executes so kind works with no Dagster. */
async function triggerDagster(source: ConnectorSource, cadence: string): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  try {
    const res = await fetch(`${config.dagsterUrl}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: ctrl.signal,
      cache: 'no-store',
      body: JSON.stringify({
        query: 'mutation($job:String!,$tags:String!){launchPipelineExecution(executionParams:{selector:{pipelineName:$job},tags:$tags})}',
        variables: { job: 'files_connector_sync', tags: `${source.id}:${cadence}` },
      }),
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
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
  void triggerDagster(source, source.initialDone ? 'incremental' : 'overnight');
  return runSync(source, client, makeStoreSink(source));
}
