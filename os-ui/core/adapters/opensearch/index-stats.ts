/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    What OpenSearch itself holds for a set of units (files, workflows), and its own search counters
 * USER STORY: As a Monitoring viewer I want "indexed" to mean OpenSearch has rows for my file or
 *             workflow, and the newest ingest time to be the one OpenSearch stored — not the OS's
 *             record of having written them.
 * ARCHITECTURE: the documented search API (terms + max aggregations,
 *   https://docs.opensearch.org/latest/aggregations/) and the index stats API
 *   (`GET /<index>/_stats/search`). The query is filtered to the ASKED ids, so rows of other
 *   units never leave OpenSearch. An unreachable cluster is ok:false, never an empty success; an index
 *   that does not exist (404) is ok:false `not_found` — "index absent" is not "0 rows". Read-only; goes through the one OpenSearch client.
 */
import type { Fetched } from '../_contract';
import { failed, fetched } from '../health/http';
import { opensearchTry } from './client';

export type UnitRows = { rows: number; newest: string | null };

type TermsReply = { aggregations?: { u?: { buckets?: { key: string; doc_count: number; newest?: { value_as_string?: string; value?: number | null } }[] } } };

export async function unitRowStats(index: string, unitField: string, ids: readonly string[], timeField?: string): Promise<Fetched<Map<string, UnitRows>>> {
  const out = new Map<string, UnitRows>();
  if (ids.length === 0) return fetched(out);
  const body = {
    size: 0,
    query: { terms: { [unitField]: [...ids] } },
    aggs: { u: { terms: { field: unitField, size: ids.length }, ...(timeField ? { aggs: { newest: { max: { field: timeField } } } } : {}) } },
  };
  const res = await opensearchTry(`/${encodeURIComponent(index)}/_search`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res) return failed('unreachable', 'OpenSearch did not answer');
  if (res.status === 404) return failed('not_found', `OpenSearch index "${index}" does not exist (not set up, or nothing has been indexed yet)`);
  if (res.status === 401 || res.status === 403) return failed(res.status === 401 ? 'unauthorized' : 'forbidden', `OpenSearch answered ${res.status}`);
  if (!res.ok) return failed('invalid', `OpenSearch answered ${res.status}`);
  let j: TermsReply;
  try {
    j = (await res.json()) as TermsReply;
  } catch (e) {
    return failed('invalid', `OpenSearch answered a body that is not JSON: ${(e as Error).message}`);
  }
  const asked = new Set(ids);
  for (const b of j.aggregations?.u?.buckets ?? []) {
    if (!asked.has(b.key)) continue; // a second guard behind the query filter
    out.set(b.key, { rows: b.doc_count, newest: b.newest?.value_as_string ?? (typeof b.newest?.value === 'number' ? new Date(b.newest.value).toISOString() : null) });
  }
  return fetched(out);
}

export type SearchCounters = { queries: number; totalMs: number };

/** OpenSearch's own cumulative search counters for one index (`query_total`, `query_time_in_millis`). */
export async function indexSearchCounters(index: string): Promise<Fetched<SearchCounters>> {
  const res = await opensearchTry(`/${encodeURIComponent(index)}/_stats/search`, { method: 'GET' });
  if (!res) return failed('unreachable', 'OpenSearch did not answer');
  if (res.status === 404) return failed('not_found', `OpenSearch index "${index}" does not exist (not set up, or nothing has been indexed yet)`);
  if (!res.ok) return failed('invalid', `OpenSearch answered ${res.status}`);
  type StatsReply = { _all?: { total?: { search?: { query_total?: number; query_time_in_millis?: number } } } };
  let j: StatsReply;
  try {
    j = (await res.json()) as StatsReply;
  } catch (e) {
    return failed('invalid', `OpenSearch answered a body that is not JSON: ${(e as Error).message}`);
  }
  const s = j._all?.total?.search;
  if (!s || typeof s.query_total !== 'number' || typeof s.query_time_in_millis !== 'number') return failed('invalid', 'OpenSearch answered no search stats');
  return fetched({ queries: s.query_total, totalMs: s.query_time_in_millis });
}
