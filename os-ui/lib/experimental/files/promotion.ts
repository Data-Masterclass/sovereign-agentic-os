/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { FileAsset } from './asset-schema.ts';

/**
 * The Files promotion gate — the LIGHT documentation minimum a file must carry
 * before it can leave the private store and become a domain asset (locked
 * decision #5: **owner + description + ≥1 tag**). Files are unstructured, so this
 * is deliberately lighter than the Data tab's column-doc transparency gate; the
 * principle is the same — nothing enters the governed/shared store undocumented.
 *
 * Pure + tested so the request path (store) and the apply path (Governance) both
 * enforce exactly the same rule.
 */

export type GateResult = { ok: boolean; missing: string[] };

export function promotionGate(a: FileAsset): GateResult {
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
