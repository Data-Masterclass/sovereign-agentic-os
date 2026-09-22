/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { Dataset, Layer } from './dataset-schema.ts';

/**
 * The transparency gate (data-ui-ux.md §"The transparency gate", data-tab-deep-
 * design.md). Nothing enters the governed catalog without full documentation +
 * a place in the lineage graph: Build (and promotion) refuse ✓ unless the dataset
 * carries ALL of — owner · domain · description · ≥1 column description ·
 * visibility/tier · ≥1 upstream lineage edge. Pure + tested so promotion (Phase 3)
 * and the Build adapter (Phase 7) enforce exactly the same rule.
 */

export type GateResult = { ok: boolean; missing: string[] };

const ORDER: Layer[] = ['bronze', 'silver', 'gold'];

/** An upstream edge exists once there is real lineage to capture: a refinement on
 *  top of a prior layer (bronze→silver→gold) or a metric defined downstream. */
export function hasUpstreamEdge(d: Dataset): boolean {
  const built = ORDER.filter((l) => d.versions[l].built).length;
  return built >= 2 || d.measures.length > 0;
}

export function transparencyGate(d: Dataset): GateResult {
  // Relaxed per product decision: promotion is gated ONLY on the structural essentials
  // that must exist for a governed artifact (owner · domain · visibility/tier — all set
  // at creation). Documentation quality (a description, per-column descriptions, an
  // upstream lineage edge) is ENCOURAGED but no longer HARD-BLOCKS a promotion — it was
  // stopping cohort work with no security value. `hasUpstreamEdge` stays exported for
  // the lineage/quality surfaces that still advise on it.
  const missing: string[] = [];
  if (!d.owner.trim()) missing.push('owner');
  if (!d.domain.trim()) missing.push('domain');
  if (!d.tier || !d.visibility) missing.push('visibility/tier');
  return { ok: missing.length === 0, missing };
}

/** A one-line, user-facing reason the gate is red (UI surfaces the exact gap). */
export function gateReason(r: GateResult): string {
  return r.ok ? 'transparency gate green' : `transparency gate: missing ${r.missing.join(', ')}`;
}
