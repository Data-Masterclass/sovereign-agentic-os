/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Monitoring → Knowledge panels — per knowledge workflow: index status and staleness from
 *             OpenSearch, and (admin) OpenSearch's own search latency counters
 * USER STORY: As a knowledge owner I want to know which of my published workflows agents can really
 *             retrieve, and which were edited after they were last indexed.
 * ARCHITECTURE:
 *   - Server-only, READ-ONLY. Workflows = the Knowledge tab's own scoped list (`listWorkflows`,
 *     injected through `sources.ts`).
 *   - Rows and the newest `ingested_at` come from OpenSearch itself: a terms + max aggregation on
 *     `workflow_id` restricted to the ASKED ids. OpenSearch down ⇒ `unavailable`, fields absent (never 0).
 *   - Search latency: OpenSearch's cumulative `query_time_in_millis / query_total` for the knowledge
 *     index. It is index-wide (it counts everyone's queries), so only an admin receives it.
 *   - Not available upstream (said in the payload): per-scope search latency, zero-result searches.
 */
import 'server-only';
import type { CurrentUser } from '@core/kernel/auth';
import { config } from '@core/kernel/config';
import { indexSearchCounters, unitRowStats } from '@core/adapters/opensearch/index-stats';
import { monitoringSources, SOURCES_MISSING, type KnowledgeRow } from '@tabs/monitoring/lib/panels/sources';
import { knowledgeIndexState, live, unavailable, type KnowledgeIndexState, type NotUpstream, type SourceState } from '@tabs/monitoring/lib/panels/panels-core';

export type KnowledgePanel = {
  id: string;
  title: string;
  domain: string;
  scope: 'mine' | 'domain' | 'marketplace';
  status: 'draft' | 'live';
  certified: boolean;
  updatedAt: string;
  knowledgeUrl: string;
  /** Absent when OpenSearch did not answer. */
  index?: { state: KnowledgeIndexState; rows: number; lastIndexedAt: string | null };
};

export type KnowledgeView = {
  view: 'knowledge';
  generatedAt: string;
  sources: { inventory: SourceState; openSearch: SourceState };
  summary: { total: number; indexed: number; stale: number; notIndexed: number; draftsNotIndexed: number } | null;
  /** Admin only: OpenSearch's cumulative search counters for the knowledge index. */
  searchLatency?: { queries: number; avgMs: number | null };
  /** Admin only: why the counters could not be read (OpenSearch down, or the index absent) — never shown as 0 or hidden. */
  searchLatencyUnavailable?: string;
  workflows: KnowledgePanel[];
  notUpstream: NotUpstream[];
};

const NOT_UPSTREAM: NotUpstream[] = [
  { panel: 'Search latency per scope', reason: 'OpenSearch counts query time per index, not per user or domain. The index-wide average is shown to admins only; a per-scope latency does not exist upstream.' },
  { panel: 'Zero-result searches', reason: 'OpenSearch keeps no search log (its slow log records only queries above a threshold), and the OS’s retrieval observation in Langfuse is a point event whose hit count Langfuse cannot aggregate per scope. Nothing logs “searched, found nothing”.' },
];

const rank: Record<KnowledgeIndexState, number> = { not_indexed: 3, stale: 2, indexed: 1, draft_not_indexed: 0 };

export async function knowledgeView(user: CurrentUser, nowMs = Date.now()): Promise<KnowledgeView> {
  const src = monitoringSources();
  const listed = src?.knowledge
    ? await src.knowledge({ id: user.id, domains: user.domains, role: user.role }).then((rows) => ({ ok: true as const, rows }), (e: Error) => ({ ok: false as const, error: e.message }))
    : { ok: false as const, error: src ? 'the Knowledge reader is not registered in this process (monitoring-sources.ts at boot)' : SOURCES_MISSING };
  const rows: KnowledgeRow[] = listed.ok ? listed.rows : [];
  const isAdmin = user.role === 'admin';
  const [os, counters] = await Promise.all([
    unitRowStats(config.knowledgeIndex, 'workflow_id', rows.map((r) => r.id), 'ingested_at'),
    isAdmin ? indexSearchCounters(config.knowledgeIndex) : Promise.resolve(null),
  ]);

  const workflows: KnowledgePanel[] = rows.map((r) => ({
    id: r.id, title: r.title, domain: r.domain, scope: r.scope, status: r.status, certified: r.certified, updatedAt: r.updatedAt,
    knowledgeUrl: `/knowledge?workflow=${encodeURIComponent(r.id)}`,
    ...(os.ok ? { index: { state: knowledgeIndexState(r, os.value.get(r.id)), rows: os.value.get(r.id)?.rows ?? 0, lastIndexedAt: os.value.get(r.id)?.newest ?? null } } : {}),
  }));
  workflows.sort((a, b) => (b.index ? rank[b.index.state] : 0) - (a.index ? rank[a.index.state] : 0) || a.title.localeCompare(b.title));
  const count = (s: KnowledgeIndexState) => workflows.filter((w) => w.index?.state === s).length;

  return {
    view: 'knowledge',
    generatedAt: new Date(nowMs).toISOString(),
    sources: { inventory: listed.ok ? live : unavailable(`knowledge: ${listed.error}`), openSearch: os.ok ? live : unavailable(`OpenSearch: ${os.detail}`) },
    summary: listed.ok && os.ok ? { total: workflows.length, indexed: count('indexed'), stale: count('stale'), notIndexed: count('not_indexed'), draftsNotIndexed: count('draft_not_indexed') } : null,
    ...(counters ? (counters.ok ? { searchLatency: { queries: counters.value.queries, avgMs: counters.value.queries > 0 ? counters.value.totalMs / counters.value.queries : null } } : { searchLatencyUnavailable: `OpenSearch: ${counters.detail}` }) : {}),
    workflows,
    notUpstream: NOT_UPSTREAM,
  };
}
