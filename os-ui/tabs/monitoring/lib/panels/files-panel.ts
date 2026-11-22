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
import { monitoringSources, SOURCES_MISSING, type FileRow } from '@tabs/monitoring/lib/panels/sources';
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
  files: FilePanel[];
  truncated: boolean;
  notUpstream: NotUpstream[];
};

const NOT_UPSTREAM: NotUpstream[] = [
  { panel: 'Trivy findings on uploads', reason: 'Trivy is wired to Software apps only (the deploy review). No engine scans an uploaded file, so there is no finding to show — a file is never marked “clean”.' },
  { panel: 'Docling job history', reason: 'Docling keeps no history of past conversions. The status and failure shown are the answer the OS recorded on each file when it called Docling.' },
];

const attention = (f: FilePanel): number =>
  (f.conversion === 'failed' ? 4 : 0) + (f.indexing === 'failed' ? 4 : 0) + (f.agreement === 'missing_in_index' || f.agreement === 'unrecorded_rows' ? 3 : 0) + (f.conversion === 'pending' ? 1 : 0) + (f.indexing === 'not_indexed' ? 1 : 0);

export async function filesView(user: CurrentUser, nowMs = Date.now()): Promise<FilesView> {
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

  return {
    view: 'files',
    generatedAt: new Date(nowMs).toISOString(),
    sources: { inventory: listed.ok ? live : unavailable(`files: ${listed.error}`), openSearch: os.ok ? live : unavailable(`OpenSearch: ${os.detail}`) },
    summary,
    conversionFailuresByCode: byCode,
    files: sorted.slice(0, FILES_LISTED),
    truncated: sorted.length > FILES_LISTED,
    notUpstream: NOT_UPSTREAM,
  };
}
