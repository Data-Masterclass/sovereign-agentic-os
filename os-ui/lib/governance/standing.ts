/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { ApprovalKind } from '../approvals.ts';
import { osMirror } from '../os-mirror.ts';

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

type StandingStoreState = { store: Map<string, StandingPolicy>; hydration: Promise<void> | null };
const STANDING_KEY = Symbol.for('soa.governance.standing');
function standingState(): StandingStoreState {
  const g = globalThis as unknown as Record<symbol, StandingStoreState | undefined>;
  if (!g[STANDING_KEY]) g[STANDING_KEY] = { store: new Map(), hydration: null };
  return g[STANDING_KEY]!;
}
function standingStore(): Map<string, StandingPolicy> {
  return standingState().store;
}

// ---------------------------------------------------- durable mirror (best-effort) --
const mirror = osMirror({
  index: 'os-standing-policies',
  createBody: {
    mappings: {
      properties: {
        id: { type: 'keyword' },
        match: { type: 'keyword' },
        domain: { type: 'keyword' },
        createdBy: { type: 'keyword' },
        createdAt: { type: 'date' },
        action: { type: 'keyword' },
        decision: { type: 'object', enabled: false },
      },
    },
  },
});

function writeThrough(policy: StandingPolicy): void {
  mirror.writeThrough(policy.id, policy);
}

export async function ensureHydrated(): Promise<void> {
  const s = standingState();
  if (!s.hydration) s.hydration = hydrate();
  return s.hydration;
}

async function hydrate(): Promise<void> {
  const s = standingState();
  const docs = (await mirror.hydrate(1000)) ?? [];
  for (const p of docs as StandingPolicy[]) {
    // CRITICAL: key by p.match, not p.id (standing store keyed by match)
    if (p && p.match && !s.store.has(p.match)) s.store.set(p.match, p);
  }
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
  writeThrough(p);
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
  const s = standingState();
  s.store.clear();
  s.hydration = null;
  mirror.__reset();
}
