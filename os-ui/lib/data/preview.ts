/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { QueryResult } from '../governed.ts';
import { previewSql } from './profile.ts';
import { isNotMaterialized, notMaterializedReason } from './materialized.ts';

/**
 * Row-preview core — the PURE orchestrator behind `GET /api/data/datasets/[id]/preview`.
 *
 * The route resolves the caller-scoped physical FQN (tier-aware, server-side) and
 * injects the governed read (`queryRun(sql, principal)`), exactly like the ask/profile
 * surfaces — so masking + row filters ride along. This module never touches the store,
 * the network or `server-only`, so every honest branch is unit-testable:
 *   • no built layer / no FQN  → calm "not materialized" (nothing to preview);
 *   • the query throws TABLE_NOT_FOUND / "does not exist" → calm "not materialized"
 *     (registered but never built), NEVER a raw Trino error to the student;
 *   • any other failure (engine unreachable, OPA refusal) → an honest fault message;
 *   • success → the columns + a bounded set of rows to scan.
 */

export const PREVIEW_DEFAULT_LIMIT = 50;
export const PREVIEW_MAX_LIMIT = 200;

/** Clamp a requested row count into a sane, bounded window. */
export function clampLimit(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return PREVIEW_DEFAULT_LIMIT;
  return Math.min(PREVIEW_MAX_LIMIT, Math.max(1, Math.floor(n)));
}

export type PreviewOutcome =
  | {
      available: true;
      layer: string;
      fqn: string;
      limit: number;
      columns: string[];
      rows: string[][];
      rowCount: number;
    }
  | { available: false; layer?: string; fqn?: string; reason: string };

/**
 * One governed preview turn: bounded `SELECT * … LIMIT n` over the resolved target.
 * `target` is null when nothing is built (the store's {@link builtLayerFqn} returns
 * null) — answered as a calm not-materialized state rather than a doomed query.
 */
export async function runPreview(input: {
  target: { layer: string; fqn: string } | null;
  limit?: unknown;
  query: (sql: string) => Promise<QueryResult>;
}): Promise<PreviewOutcome> {
  const limit = clampLimit(input.limit ?? PREVIEW_DEFAULT_LIMIT);

  if (!input.target) {
    return { available: false, reason: notMaterializedReason('This dataset') };
  }
  const { layer, fqn } = input.target;

  let res: QueryResult;
  try {
    res = await input.query(previewSql(fqn, limit));
  } catch (e) {
    if (isNotMaterialized(e)) {
      return { available: false, layer, fqn, reason: notMaterializedReason(`This ${layer} version`) };
    }
    return { available: false, layer, fqn, reason: `Could not read this ${layer} version — ${(e as Error).message}` };
  }

  return {
    available: true,
    layer,
    fqn,
    limit,
    columns: res.columns,
    rows: res.rows,
    rowCount: res.rows.length,
  };
}
