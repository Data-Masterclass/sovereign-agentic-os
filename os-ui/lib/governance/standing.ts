/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { ApprovalKind } from '../approvals.ts';

/**
 * Standing policies — the "approve & remember" half of an approval (governance-
 * golden-path.md §1). When an approver picks "approve & remember", the one-off
 * decision is promoted to a durable rule so the SAME shape of request is allowed
 * automatically next time (and shows in the Policies view). Authoritative
 * in-process store with a best-effort OpenSearch mirror, like the rest of the OS.
 */

export type StandingPolicy = {
  id: string;
  kind: ApprovalKind;
  /** A stable key describing the request shape this rule auto-allows. */
  match: string;
  domain: string;
  createdBy: string;
  createdAt: string;
  /** Sourced from the approval it was promoted from. */
  fromApproval: string;
};

const STANDING_KEY = Symbol.for('soa.governance.standing');
function standingStore(): Map<string, StandingPolicy> {
  const g = globalThis as unknown as Record<symbol, Map<string, StandingPolicy> | undefined>;
  if (!g[STANDING_KEY]) g[STANDING_KEY] = new Map();
  return g[STANDING_KEY]!;
}

/** Stable shape-key so a later identical request matches a remembered rule. */
export function matchKey(kind: ApprovalKind, payload: Record<string, unknown>): string {
  const subject =
    payload.app ?? payload.endpoint ?? payload.dataset ?? payload.tool ?? payload.action ?? '*';
  return `${kind}:${String(subject)}`;
}

export function remember(input: {
  kind: ApprovalKind;
  payload: Record<string, unknown>;
  domain: string;
  createdBy: string;
  fromApproval: string;
}): StandingPolicy {
  const match = matchKey(input.kind, input.payload);
  const id = `std_${Math.random().toString(36).slice(2, 9)}`;
  const p: StandingPolicy = {
    id,
    kind: input.kind,
    match,
    domain: input.domain,
    createdBy: input.createdBy,
    createdAt: new Date().toISOString(),
    fromApproval: input.fromApproval,
  };
  standingStore().set(match, p); // keyed by shape so re-remembering is idempotent
  return p;
}

/** Is there a standing policy that auto-allows this request shape? */
export function isRemembered(kind: ApprovalKind, payload: Record<string, unknown>): boolean {
  return standingStore().has(matchKey(kind, payload));
}

export function listStanding(domains?: string[]): StandingPolicy[] {
  return [...standingStore().values()]
    .filter((p) => (domains ? domains.includes(p.domain) : true))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function __resetStanding(): void {
  standingStore().clear();
}
