/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { config } from '@/lib/core/config';
import { readFetch } from '../util';
import { MOCK_PIPELINES } from '../mock';
import type { Health, HealthItem } from '../types';

/**
 * Pipeline-health adapter (lens 2) — Dagster run status + dbt test/source-freshness.
 * READ-ONLY (Dagster GraphQL query only — never a launch/terminate mutation).
 * Live where Dagster is up; offline-mock otherwise. Domain is read from the
 * Dagster run tags (`domain`) where present.
 */

const RUNS_QUERY = `query { runsOrError(limit: 25) { __typename ... on Runs {
  results { runId status pipelineName startTime tags { key value } } } } }`;

function runStatusHealth(status: string): Health {
  const s = status.toUpperCase();
  if (s === 'FAILURE' || s === 'CANCELED') return 'red';
  if (s === 'STARTED' || s === 'QUEUED') return 'amber';
  if (s === 'SUCCESS') return 'green';
  return 'unknown';
}

export async function collectPipelines(): Promise<HealthItem[]> {
  const res = await readFetch(
    `${config.dagsterUrl}/graphql`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ query: RUNS_QUERY }),
    },
    3000,
  );
  if (res && res.ok) {
    try {
      const data = JSON.parse(await res.text());
      const results = data?.data?.runsOrError?.results;
      if (Array.isArray(results) && results.length > 0) {
        return results.map((r: Record<string, unknown>): HealthItem => {
          const tags = (Array.isArray(r.tags) ? r.tags : []) as { key: string; value: string }[];
          const domain = tags.find((t) => t.key === 'domain')?.value ?? 'platform';
          const owner = tags.find((t) => t.key === 'owner')?.value ?? domain;
          const status = String(r.status ?? 'UNKNOWN');
          return {
            id: `pl-${String(r.runId ?? '')}`,
            lens: 'pipelines',
            title: `${String(r.pipelineName ?? 'pipeline')} — Dagster run`,
            health: runStatusHealth(status),
            detail: `Dagster ${status.toLowerCase()}. dbt tests/freshness via run metadata.`,
            owner,
            domain,
            ts: r.startTime ? new Date(Number(r.startTime) * 1000).toISOString() : undefined,
            links: { pipelineId: `pl-${String(r.runId ?? '')}` },
            source: 'live',
          };
        });
      }
    } catch {
      /* fall through to mock */
    }
  }
  // Offline-mock — the worked-example dbt freshness failure on mart_sales.
  return [...MOCK_PIPELINES];
}
