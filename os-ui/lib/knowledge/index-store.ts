/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { type KnowledgeUnit } from './chunk.ts';

/**
 * In-process indexed-unit store — the OFFLINE mirror of the OpenSearch knowledge
 * index (kind / no-cluster). The index pipeline writes embedded units here; the
 * retriever reads from here when OpenSearch is unreachable. Keyed by unit id so a
 * re-index of a workflow REPLACES its units (incremental, no duplicates).
 */

export type IndexedUnit = KnowledgeUnit & { embedding: number[]; indexedAt: string };

const IDX_KEY = Symbol.for('soa.knowledge.index');
function idx(): Map<string, IndexedUnit> {
  const g = globalThis as unknown as Record<symbol, Map<string, IndexedUnit> | undefined>;
  if (!g[IDX_KEY]) g[IDX_KEY] = new Map();
  return g[IDX_KEY]!;
}

/**
 * Replace all units belonging to a scope (a workflow id, or `domain:<name>`) then
 * add the new ones — an incremental re-index that never leaves stale duplicates.
 */
export function upsertUnits(scopeKey: string, units: IndexedUnit[]): void {
  for (const [id, u] of [...idx()]) {
    const key = u.provenance.workflowId ?? `domain:${u.provenance.domain}`;
    if (key === scopeKey) idx().delete(id);
  }
  for (const u of units) idx().set(u.id, u);
}

/** All indexed units (the retriever's offline candidate set). */
export function allUnits(): IndexedUnit[] {
  return [...idx().values()];
}

export function unitCount(): number {
  return idx().size;
}

/** Whether a given workflow already has indexed units (per-scope check — used to
 *  decide if an on-demand retrieval must index this workflow first). */
export function hasWorkflowUnits(workflowId: string): boolean {
  for (const u of idx().values()) if (u.provenance.workflowId === workflowId) return true;
  return false;
}

/** Test hook. */
export function __resetIndex(): void {
  idx().clear();
}
