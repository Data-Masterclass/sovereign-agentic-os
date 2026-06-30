/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { Dataset, Measure } from '../data/dataset-schema.ts';
import { type DelegatedToken, propagate } from '../data/identity.ts';
import { dimensionMember, measureMember } from './model.ts';

/**
 * The metric explorer — pick a metric + dimensions to slice, no SQL, per-viewer RLS.
 *
 * R3 is the whole point here: the query is resolved at Cube under the VIEWER'S identity
 * (`securityContext`), never a shared service identity, so two people exploring the same
 * metric see DIFFERENT rows. We derive the security context from the same delegated
 * token the agent `metrics` tool uses ({@link propagate}), so the explorer and the agent
 * are the same row-filtered query. Pure: the Cube load is injected, unit-tested with an
 * in-memory executor that honours the security context.
 *
 * Analysts can `dropToSql` to the Cube SQL API / Trino for ad-hoc work beyond the metric.
 */

export type Granularity = 'day' | 'week' | 'month' | 'quarter' | 'year';

export type ExploreSpec = {
  /** The canonical measure member to chart (the single source of the number). */
  member: string;
  /** Dimension members to slice by. */
  dimensions: string[];
  /** Optional time dimension + granularity. */
  timeDimension?: string;
  granularity?: Granularity;
  limit?: number;
};

/** Build an ExploreSpec from a dataset + measure + chosen slice (UI convenience). */
export function exploreSpec(
  dataset: Dataset,
  measure: Measure,
  slice: { dimensions?: string[]; timeDimension?: string; granularity?: Granularity; limit?: number } = {},
): ExploreSpec {
  return {
    member: measureMember(dataset, measure),
    dimensions: (slice.dimensions ?? []).map((d) => dimensionMember(dataset, d)),
    timeDimension: slice.timeDimension ? dimensionMember(dataset, slice.timeDimension) : undefined,
    granularity: slice.granularity,
    limit: slice.limit,
  };
}

/** A Cube REST `load` query (the shape Cube's /v1/load accepts). */
export type CubeQuery = {
  measures: string[];
  dimensions: string[];
  timeDimensions?: { dimension: string; granularity: Granularity }[];
  limit: number;
};

export function buildCubeQuery(spec: ExploreSpec): CubeQuery {
  return {
    measures: [spec.member],
    dimensions: spec.dimensions,
    timeDimensions:
      spec.timeDimension && spec.granularity
        ? [{ dimension: spec.timeDimension, granularity: spec.granularity }]
        : undefined,
    limit: spec.limit ?? 100,
  };
}

/** The injected Cube executor — resolves a query UNDER a security context (RLS at Cube). */
export type CubeExecutor = {
  load(query: CubeQuery, securityContext: Record<string, unknown>): Promise<{ rows: Record<string, unknown>[] }>;
};

export type ExploreResult = {
  member: string;
  securityContext: Record<string, unknown>;
  rows: Record<string, unknown>[];
};

/**
 * Explore a metric under the viewer's delegated identity. R3: the security context is
 * derived from the token (not a service account — {@link propagate} asserts delegation),
 * so the row filter is the viewer's. Two tokens → two security contexts → two row sets.
 */
export async function explore(spec: ExploreSpec, token: DelegatedToken, exec: CubeExecutor): Promise<ExploreResult> {
  const { cube } = propagate(token); // throws if the token isn't user-delegated (R2/R3)
  const { rows } = await exec.load(buildCubeQuery(spec), cube.securityContext);
  return { member: spec.member, securityContext: cube.securityContext, rows };
}

/**
 * Drop to SQL — the analyst escape hatch. Cube exposes each view as a SQL table (the SQL
 * API, Postgres protocol); the same member is `"View"."measure"`, so the SQL the analyst
 * sees still resolves the governed metric (and Cube still applies RLS). For ad-hoc work
 * beyond the metric they can point this at Trino.
 */
export function dropToSql(spec: ExploreSpec): string {
  const [view, measure] = spec.member.split('.');
  const dims = spec.dimensions.map((d) => `"${d.split('.')[1]}"`);
  const select = [...dims, `"${measure}"`].join(', ');
  const groupBy = dims.length ? `\nGROUP BY ${dims.join(', ')}` : '';
  return `-- Cube SQL API (RLS still applies). Repoint at Trino for ad-hoc beyond the metric.\nSELECT ${select}\nFROM "${view}"${groupBy}\nLIMIT ${spec.limit ?? 100}`;
}
