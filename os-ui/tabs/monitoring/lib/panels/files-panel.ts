/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Monitoring → Files panels — per file: Docling conversion status and failures, indexing
 *             status checked against what OpenSearch itself holds
 * USER STORY: As a file owner or a domain builder I want to see which uploads were converted, which
 *             conversions failed and why, and which files are really searchable — and be told where the
 *             OS's record and OpenSearch disagree.
 * ARCHITECTURE:
 *   - Server-only, READ-ONLY. Files = the Files tab's own scoped list (`listFiles`, injected through
 *     `sources.ts`): creator own, builder own + domain, admin all — the same rule as the tab.
 *   - Conversion = the Docling result the OS recorded on the file (Docling keeps no job history; the
 *     recorded code and reason are its answer, said so in the payload).
 *   - Indexing = the recorded index outcome, cross-checked with OpenSearch: a terms aggregation on
 *     `file_id` restricted to the ASKED ids (`unitRowStats`). OpenSearch down ⇒ the cross-check is
 *     `unavailable`, the per-file row count absent (never 0).
 *   - Not available upstream (said in the payload): Trivy findings on uploads — Trivy runs on
 *     Software apps only; no engine scans an uploaded file.
 */
import 'server-only';
import type { CurrentUser } from '@core/kernel/auth';
import { config } from '@core/kernel/config';
import { unitRowStats } from '@core/adapters/opensearch/index-stats';
import * as dagster from '@core/infra/dagster';
import { DRIVE_SYNC_JOB, DRIVE_SYNC_SCHEDULE, lagMs, lagThresholdMs, lastRun, type SyncRunRecord } from '@core/infra/drive-sync-health';
import { monitoringSources, SOURCES_MISSING, type DriveRow, type FileRow, type PanelPrincipal } from '@tabs/monitoring/lib/panels/sources';
import { conversionOf, indexAgreement, indexingOf, live, unavailable, type FileConversion, type FileIndexing, type NotUpstream, type SourceState } from '@tabs/monitoring/lib/panels/panels-core';

/** Files listed per response; the counts always cover every file in scope. */
export const FILES_LISTED = 200;

export type FilePanel = {
  id: string;
  name: string;
  domain: string;
  scope: 'mine' | 'domain' | 'marketplace';
  kind: string;
  bytes: number;
  filesUrl: string;
  conversion: FileConversion;
  conversionFailure?: { code: string | null; reason: string | null; at: string | null };
  indexing: FileIndexing;
  indexingFailure?: { reason: string | null; at: string | null };
  /** Chunks the index run recorded writing. */
  recordedChunks?: number;
  /** Rows OpenSearch itself holds for this file; absent when OpenSearch did not answer. */
  openSearchRows?: number;
  agreement: 'agrees' | 'missing_in_index' | 'unrecorded_rows' | 'unknown';
};

export type FilesView = {
  view: 'files';
  generatedAt: string;
  sources: { inventory: SourceState; openSearch: SourceState };
  summary: { total: number; searchable: number; storedOnly: number; notIndexed: number; indexingFailed: number; converting: number; conversionFailed: number; disagreements: number } | null;
  conversionFailuresByCode: Record<string, number>;
  drives: DrivesSection;
  files: FilePanel[];
  truncated: boolean;
  notUpstream: NotUpstream[];
};

export type DriveState = 'ok' | 'failed' | 'lagging' | 'paused' | 'needs_reconnect' | 'never_synced';

export type DrivePanel = {
  id: string;
  provider: 'google-drive' | 'onedrive';
  label: string;
  domain: string;
  owner: string;
  mode: 'copy' | 'reference';
  state: DriveState;
  /** The newest run on record; null when the drive never synced. */
  lastSync: SyncRunRecord | null;
  /** Minutes since the last successful sync ended; null when it never succeeded (never 0). */
  lagMinutes: number | null;
  /** Remote files in the import ledger. */
  filesImported: number;
  paused: { reason: string; at: string } | null;
  connection: 'healthy' | 'needs-reconnect' | 'unknown';
  /** Failed runs among the kept history, and how many runs the history holds. */
  failedRuns: number;
  historyRuns: number;
  recentRuns: SyncRunRecord[];
  connectionsUrl: string;
};

export type DrivesSection = {
  sources: { drives: SourceState; dagster: SourceState };
  /** The Dagster schedule as Dagster reports it; null when Dagster did not answer. */
  schedule: { name: string; cron: string; status: 'RUNNING' | 'STOPPED'; nextTickAt: string | null } | null;
  /** Dagster's own newest run of the sync job; null when Dagster did not answer or has none. */
  lastDagsterRun: { runId: string; status: string; endedAt: string | null } | null;
  summary: { connections: number; failing: number; lagging: number; paused: number; needsReconnect: number; neverSynced: number } | null;
  connections: DrivePanel[];
};

/** The Files rule (`listFiles`): creator own · builder / domain admin own + their domains · admin all. */
export function driveInScope(row: Pick<DriveRow, 'owner' | 'domain'>, p: PanelPrincipal): boolean {
  if (p.role === 'admin') return true;
  if (row.owner === p.id) return true;
  return (p.role === 'builder' || p.role === 'domain_admin') && p.domains.includes(row.domain);
}

export function driveState(row: DriveRow, lag: number | null, nowMs: number, thresholdMs: number): DriveState {
  if (row.paused) return 'paused';
  if (row.connectionHealth === 'needs-reconnect') return 'needs_reconnect';
  const last = lastRun(row.runs);
  if (last && !last.ok) return 'failed';
  if (!last) return nowMs - Date.parse(row.createdAt) > thresholdMs ? 'lagging' : 'never_synced';
  return lag !== null && lag > thresholdMs ? 'lagging' : 'ok';
}

const driveRank: Record<DriveState, number> = { failed: 5, needs_reconnect: 4, paused: 3, lagging: 2, never_synced: 1, ok: 0 };

const NOT_UPSTREAM: NotUpstream[] = [
  { panel: 'Files removed in the drive', reason: 'The sync imports and updates files; it does not see or apply deletions in the drive, so there is no removed count — a file deleted upstream stays in Files until its owner deletes it.' },
  { panel: 'Failed files within a run', reason: 'A run stops at its first failure and records its error text; there is no per-file failure tally. Per-file read and index status is the file list below.' },
  { panel: 'Trivy findings on uploads', reason: 'Trivy is wired to Software apps only (the deploy review). No engine scans an uploaded file, so there is no finding to show — a file is never marked “clean”.' },
  { panel: 'Docling job history', reason: 'Docling keeps no history of past conversions. The status and failure shown are the answer the OS recorded on each file when it called Docling.' },
];

const attention = (f: FilePanel): number =>
  (f.conversion === 'failed' ? 4 : 0) + (f.indexing === 'failed' ? 4 : 0) + (f.agreement === 'missing_in_index' || f.agreement === 'unrecorded_rows' ? 3 : 0) + (f.conversion === 'pending' ? 1 : 0) + (f.indexing === 'not_indexed' ? 1 : 0);

export async function filesView(user: CurrentUser, nowMs = Date.now(), dagsterDeps: dagster.DagsterDeps = {}): Promise<FilesView> {
  const src = monitoringSources();
  const listed = src?.files
    ? await src.files({ id: user.id, domains: user.domains, role: user.role }).then((rows) => ({ ok: true as const, rows }), (e: Error) => ({ ok: false as const, error: e.message }))
    : { ok: false as const, error: src ? 'the Files reader is not registered in this process (monitoring-sources.ts at boot)' : SOURCES_MISSING };
  const rows: FileRow[] = listed.ok ? listed.rows : [];
  const wantRows = rows.filter((r) => r.mode === 'indexed' || r.outcome);
  const os = await unitRowStats(config.filesIndex, 'file_id', wantRows.map((r) => r.id));

  const files: FilePanel[] = rows.map((r) => {
    const facts = { mode: r.mode, extraction: r.extraction, outcome: r.outcome };
    const openSearchRows = os.ok ? os.value.get(r.id)?.rows ?? 0 : undefined;
    const asked = wantRows.some((w) => w.id === r.id);
    const rowsKnown = os.ok && asked ? openSearchRows ?? 0 : null;
    const conversion = conversionOf(facts);
    const indexing = indexingOf(facts);
    return {
      id: r.id, name: r.name, domain: r.domain, scope: r.scope, kind: r.kind, bytes: r.bytes,
      filesUrl: `/files?focus=${encodeURIComponent(r.id)}`,
      conversion,
      ...(conversion === 'failed' ? { conversionFailure: { code: r.extraction?.code ?? null, reason: r.extraction?.reason ?? null, at: r.extraction?.at ?? null } } : {}),
      indexing,
      ...(indexing === 'failed' ? { indexingFailure: { reason: r.outcome?.reason ?? null, at: r.outcome?.at ?? null } } : {}),
      ...(r.outcome?.chunks !== undefined ? { recordedChunks: r.outcome.chunks } : {}),
      ...(rowsKnown !== null ? { openSearchRows: rowsKnown } : {}),
      agreement: indexAgreement(facts, rowsKnown),
    };
  });

  const summary = listed.ok
    ? {
        total: files.length,
        searchable: files.filter((f) => f.indexing === 'indexed').length,
        storedOnly: files.filter((f) => f.indexing === 'stored_only').length,
        notIndexed: files.filter((f) => f.indexing === 'not_indexed' || f.indexing === 'empty').length,
        indexingFailed: files.filter((f) => f.indexing === 'failed').length,
        converting: files.filter((f) => f.conversion === 'pending').length,
        conversionFailed: files.filter((f) => f.conversion === 'failed').length,
        disagreements: files.filter((f) => f.agreement === 'missing_in_index' || f.agreement === 'unrecorded_rows').length,
      }
    : null;
  const byCode: Record<string, number> = {};
  for (const f of files) if (f.conversionFailure) byCode[f.conversionFailure.code ?? 'unknown'] = (byCode[f.conversionFailure.code ?? 'unknown'] ?? 0) + 1;
  const sorted = [...files].sort((a, b) => attention(b) - attention(a) || a.name.localeCompare(b.name));

  const drives = await drivesSection({ id: user.id, domains: user.domains, role: user.role }, nowMs, dagsterDeps);

  return {
    view: 'files',
    generatedAt: new Date(nowMs).toISOString(),
    sources: { inventory: listed.ok ? live : unavailable(`files: ${listed.error}`), openSearch: os.ok ? live : unavailable(`OpenSearch: ${os.detail}`) },
    summary,
    conversionFailuresByCode: byCode,
    drives,
    files: sorted.slice(0, FILES_LISTED),
    truncated: sorted.length > FILES_LISTED,
    notUpstream: NOT_UPSTREAM,
  };
}

async function drivesSection(p: PanelPrincipal, nowMs: number, dagsterDeps: dagster.DagsterDeps): Promise<DrivesSection> {
  const src = monitoringSources();
  const listed = src?.driveSources
    ? await src.driveSources(p).then((rows) => ({ ok: true as const, rows }), (e: Error) => ({ ok: false as const, error: e.message }))
    : { ok: false as const, error: src ? 'the drive reader is not registered in this process (monitoring-sources.ts at boot)' : SOURCES_MISSING };
  // Dagster is read for the schedule only: the OS records every sync itself, so a Dagster outage hides the
  // schedule and Dagster's run, never the syncs.
  const [tick, runs] = await Promise.all([dagster.nextTick(DRIVE_SYNC_SCHEDULE, dagsterDeps), dagster.runsByTags({ 'os/job': 'files_drive_sync' }, 1, dagsterDeps)]);
  const dagsterErr = !tick.ok ? tick.error : !runs.ok ? runs.error : null;
  const threshold = lagThresholdMs();
  const connections: DrivePanel[] = listed.ok
    ? listed.rows
        .filter((r) => driveInScope(r, p)) // a second guard behind the reader: only what the viewer may see
        .map((r) => {
          const lag = lagMs(r.runs, r.createdAt, nowMs);
          const history = r.runs ?? [];
          return {
            id: r.id, provider: r.provider, label: r.label, domain: r.domain, owner: r.owner, mode: r.mode,
            state: driveState(r, lag, nowMs, threshold),
            lastSync: lastRun(history),
            lagMinutes: lag === null ? null : Math.round(lag / 60_000),
            filesImported: r.imported,
            paused: r.paused,
            connection: r.connectionHealth,
            failedRuns: history.filter((x) => !x.ok).length,
            historyRuns: history.length,
            recentRuns: history.slice(-5).reverse(),
            connectionsUrl: r.connectionId ? `/connections?focus=${encodeURIComponent(r.connectionId)}` : '/connections',
          };
        })
        .sort((a, b) => driveRank[b.state] - driveRank[a.state] || a.label.localeCompare(b.label))
    : [];
  const count = (s: DriveState) => connections.filter((c) => c.state === s).length;
  return {
    sources: { drives: listed.ok ? live : unavailable(`drives: ${listed.error}`), dagster: dagsterErr === null ? live : unavailable(`Dagster: ${dagsterErr}`) },
    schedule: tick.ok ? { name: tick.data.name, cron: tick.data.cron, status: tick.data.status, nextTickAt: tick.data.nextTickAt } : null,
    lastDagsterRun: runs.ok && runs.data[0] ? { runId: runs.data[0].runId, status: runs.data[0].status, endedAt: runs.data[0].endedAt } : null,
    summary: listed.ok ? { connections: connections.length, failing: count('failed'), lagging: count('lagging'), paused: count('paused'), needsReconnect: count('needs_reconnect'), neverSynced: count('never_synced') } : null,
    connections,
  };
}
