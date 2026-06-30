/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * Files catalog + lineage (OpenMetadata, mock-tolerant). Every governed event a
 * file goes through — indexed, promoted, certified, or distilled via "Use as" —
 * is recorded here as a lineage edge. The record is **always** kept in-process
 * (authoritative on a laptop with no OpenMetadata); the server boundary
 * best-effort mirrors it to the real OM REST API when one is reachable, exactly
 * like `lib/approvals.ts`' OpenSearch write-through.
 *
 * Pure module (no server/network) so the store + tests record lineage directly;
 * the OM push lives in the server layer.
 */

export type LineageKind =
  | 'file_indexed'    // file → search index (Phase 3)
  | 'file_promoted'   // dataset → asset (Phase 2)
  | 'file_certified'  // asset → product (Phase 2)
  | 'file_unshared'   // asset → dataset
  | 'file_to_knowledge' // file → derived tacit note (Phase 6)
  | 'file_to_data';   // file → derived Bronze dataset (Phase 6)

export type LineageEdge = {
  id: string;
  kind: LineageKind;
  fileId: string;
  fileName: string;
  /** The downstream entity FQN (index name, iceberg target, knowledge doc id, …). */
  target: string;
  /** Who triggered it (owner / approver). */
  by: string;
  at: string;
  note?: string;
};

const edges: LineageEdge[] = [];
const MAX = 500;

function id(): string {
  return `lin_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-4)}`;
}

export function recordLineage(input: Omit<LineageEdge, 'id' | 'at'> & { at?: string }): LineageEdge {
  const edge: LineageEdge = { id: id(), at: input.at ?? new Date().toISOString(), ...input };
  edges.push(edge);
  if (edges.length > MAX) edges.splice(0, edges.length - MAX);
  return edge;
}

export function listLineage(fileId?: string): LineageEdge[] {
  return edges
    .filter((e) => (fileId ? e.fileId === fileId : true))
    .sort((a, b) => b.at.localeCompare(a.at));
}

/** Test hook. */
export function __resetLineage(): void {
  edges.splice(0, edges.length);
}
