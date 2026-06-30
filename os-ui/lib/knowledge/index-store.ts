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

const STORE = new Map<string, IndexedUnit>();

/**
 * Replace all units belonging to a scope (a workflow id, or `domain:<name>`) then
 * add the new ones — an incremental re-index that never leaves stale duplicates.
 */
export function upsertUnits(scopeKey: string, units: IndexedUnit[]): void {
  for (const [id, u] of [...STORE]) {
    const key = u.provenance.workflowId ?? `domain:${u.provenance.domain}`;
    if (key === scopeKey) STORE.delete(id);
  }
  for (const u of units) STORE.set(u.id, u);
}

/** All indexed units (the retriever's offline candidate set). */
export function allUnits(): IndexedUnit[] {
  return [...STORE.values()];
}

export function unitCount(): number {
  return STORE.size;
}

/** Test hook. */
export function __resetIndex(): void {
  STORE.clear();
}
