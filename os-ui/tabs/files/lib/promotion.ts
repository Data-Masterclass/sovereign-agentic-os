/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { FileAsset } from '@tabs/files/lib/asset-schema';

/**
 * The Files promotion gate — the LIGHT documentation minimum a file must carry
 * before it can leave the private store and become a domain asset (locked
 * decision #5: **owner + description + ≥1 tag**). Files are unstructured, so this
 * is deliberately lighter than the Data tab's column-doc transparency gate; the
 * principle is the same — nothing enters the governed/shared store undocumented.
 *
 * Pure + tested so the request path (store) and the apply path (Governance) both
 * enforce exactly the same rule.
 *
 * THREE readers, ONE rule (2026-11-18). The gate takes only the four fields it reads, so a
 * LISTING row (`FileSummary`) passes through the identical function the store and Governance
 * use — which is why the summary carries `description`. A client-side approximation of
 * "documented" would drift from the server on its first edit, and the user would be reading a
 * promise nobody keeps.
 */

export type GateResult = { ok: boolean; missing: string[] };

/** What the gate actually reads. A `FileAsset` satisfies it; so does a `FileSummary`. */
export type GateFields = Pick<FileAsset, 'owner' | 'domain' | 'description' | 'tags'>;

export function promotionGate(a: GateFields): GateResult {
  const missing: string[] = [];
  if (!a.owner.trim()) missing.push('owner');
  if (!a.domain.trim()) missing.push('domain');
  if (!a.description.trim()) missing.push('a description');
  if (a.tags.length === 0) missing.push('at least one tag');
  return { ok: missing.length === 0, missing };
}

export function gateReason(r: GateResult): string {
  return r.ok ? 'ready to promote' : `add ${r.missing.join(', ')} first`;
}

export type Readiness = { ready: number; total: number; blocked: GateResult[] };

/**
 * PRE-FLIGHT over a selection, before anything is POSTed. The selection toolbar can then say
 * "3 of 12 ready to promote" rather than letting the user discover it twelve 400s later.
 */
export function promotionReadiness(rows: GateFields[]): Readiness {
  const blocked: GateResult[] = [];
  let ready = 0;
  for (const row of rows) {
    const gate = promotionGate(row);
    if (gate.ok) ready += 1;
    else blocked.push(gate);
  }
  return { ready, total: rows.length, blocked };
}

/** The toolbar label: "3 of 12 ready to promote". */
export function readinessLabel(r: Pick<Readiness, 'ready' | 'total'>): string {
  return `${r.ready} of ${r.total} ready to promote`;
}

/**
 * The hint on a disabled Promote: every DISTINCT gap across the blocked rows, named once —
 * a disabled button that does not say what would enable it is just a dead end.
 */
export function readinessHint(r: Pick<Readiness, 'blocked'>): string {
  const gaps = [...new Set(r.blocked.flatMap((b) => b.missing))];
  return gaps.length ? `Add ${gaps.join(', ')} first — “Describe & tag” does it for the selection.` : '';
}
