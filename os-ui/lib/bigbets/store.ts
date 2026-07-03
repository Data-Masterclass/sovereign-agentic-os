/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * The Big Bets registry (kind-only, in-process — the mock of the Supabase store).
 *
 * Holds the BigBet objects + their component references (artifact id · planned
 * date · dependency edges · status override · weight) and an audit log. It NEVER
 * holds a copy of an artifact — components are references resolved through the
 * cross-tab sources. CRUD is OPA-scoped here in the same shape the Rego policy
 * enforces (domain + role + bet membership): a Builder/Admin owns; a Creator
 * drafts; cross-domain bets are Admin-owned; a not-yet-shared component's detail
 * is members-only.
 *
 * Kept free of `server-only`/Next imports so it is unit-testable directly; the
 * API routes are the server boundary that authenticates the principal and may
 * additionally consult the live OPA decision API.
 */

import {
  type Actor,
  type AllocationMethod,
  type AuditEvent,
  type BigBet,
  type ComponentRef,
  type Lifecycle,
  type Principal,
  type ProblemStatement,
  type StatusOverride,
  type Tab,
  type ValueBasis,
  BetError,
} from './model.ts';
import { resolveArtifact, sourceFor } from './sources.ts';

/**
 * State pinned to `globalThis` so it is a TRUE singleton across all Next.js
 * route-handler module instances — a bet created via `POST /api/big-bets` is
 * immediately visible to `GET /api/big-bets` (and to the pillar-dropdown query).
 * Same pattern as `lib/marketplace/store.ts` and `lib/agents/store.ts`.
 */
type BetsState = { bets: Map<string, BigBet>; audit: AuditEvent[]; seq: number };
const STATE_KEY = Symbol.for('soa.bigbets.store');
function state(): BetsState {
  const g = globalThis as unknown as Record<symbol, BetsState | undefined>;
  if (!g[STATE_KEY]) g[STATE_KEY] = { bets: new Map(), audit: [], seq: 0 };
  return g[STATE_KEY]!;
}

function now(): string {
  return new Date().toISOString();
}
function today(): string {
  return new Date().toISOString().slice(0, 10);
}
function id(prefix: string): string {
  const s = state();
  s.seq += 1;
  return `${prefix}_${(Date.now().toString(36) + s.seq.toString(36)).slice(-8)}`;
}

function log(actor: string, action: string, betId?: string, detail?: Record<string, unknown>): void {
  state().audit.unshift({ id: id('aud'), at: now(), actor, action, betId, detail });
}

/** Test hook: wipe the registry + audit. */
export function __resetBets(): void {
  const s = state();
  s.bets.clear();
  s.audit.length = 0;
  s.seq = 0;
}

export function auditLog(betId?: string): AuditEvent[] {
  const { audit } = state();
  return betId ? audit.filter((e) => e.betId === betId) : [...audit];
}

// ----------------------------------------------------------------- scoping ---

function isMember(bet: BigBet, user: Principal): boolean {
  return bet.owner === user.id || bet.members.includes(user.id);
}

/** Who can SEE the bet at all (OPA view scope). */
export function canView(bet: BigBet, user: Principal): boolean {
  if (user.role === 'admin') return true;
  if (isMember(bet, user)) return true;
  // Domain peers can see a domain-scoped bet's summary; cross-domain is members/admin.
  return !bet.crossDomain && user.domains.includes(bet.domain);
}

/** Who can EDIT the bet (Builder/Admin owner; Admin for cross-domain). */
export function canEdit(bet: BigBet, user: Principal): boolean {
  if (user.role === 'admin') return true;
  if (bet.crossDomain) return false; // cross-domain edits are Admin-only
  return bet.owner === user.id && (user.role === 'builder' || user.role === 'creator');
}

/**
 * OPA RLS: may this user see a *not-yet-shared* component's DETAIL? Only the
 * bet's members. A shared/certified/marketplace artifact is visible to domain
 * peers; a personal (draft) one is members-only — the "no governance shortcut".
 */
export function canViewComponentDetail(bet: BigBet, ref: ComponentRef, user: Principal): boolean {
  const art = resolveArtifact(ref.artifactId);
  if (!art) return false;
  if (art.visibility !== 'personal') {
    if (user.role === 'admin') return true;
    if (isMember(bet, user)) return true;
    return user.domains.includes(art.domain);
  }
  // Not yet shared → members only (owner always a member).
  return user.role === 'admin' || isMember(bet, user);
}

function requireView(betId: string, user: Principal): BigBet {
  const bet = state().bets.get(betId);
  if (!bet) throw new BetError('Big Bet not found', 404);
  if (!canView(bet, user)) throw new BetError('Not permitted to view this bet', 403);
  return bet;
}

function requireEdit(betId: string, user: Principal): BigBet {
  const bet = state().bets.get(betId);
  if (!bet) throw new BetError('Big Bet not found', 404);
  if (!canEdit(bet, user)) throw new BetError('Not permitted to edit this bet', 403);
  return bet;
}

// ----------------------------------------------------------------- create ----

export type CreateBetInput = {
  name: string;
  problem: ProblemStatement;
  solution?: string;
  pillarId: string;
  metricId: string;
  targetValue: number;
  goLive: string;
  domain?: string;
  crossDomain?: boolean;
  valueBasis?: ValueBasis;
  allocation?: AllocationMethod;
  members?: string[];
};

export function createBet(user: Principal, input: CreateBetInput): BigBet {
  // Builder/Admin create + own; a Creator may draft.
  if (!['creator', 'builder', 'admin'].includes(user.role)) {
    throw new BetError('Only a Creator (draft), Builder or Admin can create a Big Bet', 403);
  }
  if (!input.name?.trim()) throw new BetError('A bet name is required', 400);
  const crossDomain = Boolean(input.crossDomain);
  if (crossDomain && user.role !== 'admin') {
    throw new BetError('A cross-domain Big Bet must be Admin-owned', 403);
  }
  const domain = input.domain && user.domains.includes(input.domain) ? input.domain : user.domains[0] ?? 'platform';
  const bet: BigBet = {
    id: id('bet'),
    name: input.name.trim(),
    problem: input.problem,
    solution: input.solution?.trim() || undefined,
    domain,
    crossDomain,
    owner: user.id,
    members: [...new Set([user.id, ...(input.members ?? [])])],
    pillarId: input.pillarId,
    metricId: input.metricId,
    targetValue: input.targetValue,
    valueBasis: input.valueBasis ?? 'uplift',
    allocation: input.allocation ?? 'manual',
    goLive: input.goLive,
    status: user.role === 'creator' ? 'draft' : 'active',
    components: [],
    createdBy: user.id,
    createdAt: now(),
    updatedAt: now(),
  };
  state().bets.set(bet.id, bet);
  log(user.id, 'bet.create', bet.id, { name: bet.name, pillarId: bet.pillarId });
  return bet;
}

// ------------------------------------------------------------------- read ----

export function listBets(user: Principal): BigBet[] {
  return [...state().bets.values()].filter((b) => canView(b, user)).sort((a, b) => a.name.localeCompare(b.name));
}

export function getBet(betId: string, user: Principal): BigBet {
  return requireView(betId, user);
}

// ----------------------------------------------------------------- update ----

export function updateBet(
  betId: string,
  user: Principal,
  patch: Partial<Pick<BigBet, 'name' | 'problem' | 'solution' | 'targetValue' | 'goLive' | 'valueBasis' | 'allocation' | 'ownerDeclaredValue' | 'members' | 'status'>>,
): BigBet {
  const bet = requireEdit(betId, user);
  Object.assign(bet, patch);
  if (patch.members) bet.members = [...new Set([bet.owner, ...patch.members])];
  bet.updatedAt = now();
  log(user.id, 'bet.update', betId, { fields: Object.keys(patch) });
  return bet;
}

// --------------------------------------------------------------- components --

export type AddComponentInput = {
  tab: Tab;
  /** Link an existing artifact … */
  artifactId?: string;
  /** … or scaffold a new one via the tab's governed create flow. */
  scaffold?: { title: string; consumes?: string[] };
  start?: string;
  plannedReady: string;
  dependsOn?: string[];
  weight?: number;
};

/**
 * Add a component reference. Either links an existing artifact (tagging it with
 * the bet id) or SCAFFOLDS one through the tab's own governed create flow — never
 * a fork. The new/linked artifact is the single source of truth; the bet only
 * holds the reference. `by` carries the actor kind so a planner scaffold is
 * distinguishable (and still cannot promote later).
 */
export function addComponent(betId: string, user: Actor, input: AddComponentInput): { bet: BigBet; ref: ComponentRef } {
  const bet = requireEdit(betId, user);
  const src = sourceFor(input.tab);
  let artifactId: string;
  let origin: ComponentRef['origin'];
  if (input.scaffold) {
    const art = src.scaffold({
      title: input.scaffold.title,
      domain: bet.domain,
      bigBetId: bet.id,
      by: user,
      consumes: input.scaffold.consumes,
    });
    artifactId = art.id;
    origin = 'scaffolded';
  } else if (input.artifactId) {
    const art = src.tag(input.artifactId, bet.id);
    if (!art) throw new BetError(`Artifact ${input.artifactId} not found in ${input.tab}`, 404);
    artifactId = art.id;
    origin = 'linked';
  } else {
    throw new BetError('Provide either an artifactId to link or a scaffold spec', 400);
  }
  const ref: ComponentRef = {
    id: id('ref'),
    artifactId,
    tab: input.tab,
    start: input.start ?? today(),
    plannedReady: input.plannedReady,
    dependsOn: input.dependsOn ?? [],
    weight: input.weight ?? 0,
    origin,
    addedBy: user.id,
    addedAt: now(),
  };
  bet.components.push(ref);
  bet.updatedAt = now();
  log(user.id, origin === 'scaffolded' ? 'component.scaffold' : 'component.link', bet.id, {
    tab: input.tab,
    artifactId,
    refId: ref.id,
    actorKind: user.kind ?? 'human',
  });
  return { bet, ref };
}

function findRef(bet: BigBet, refId: string): ComponentRef {
  const ref = bet.components.find((c) => c.id === refId);
  if (!ref) throw new BetError(`Component ${refId} not found on this bet`, 404);
  return ref;
}

/** Remove a component reference (untags the artifact; NEVER deletes it). */
export function removeComponent(betId: string, user: Principal, refId: string): BigBet {
  const bet = requireEdit(betId, user);
  const ref = findRef(bet, refId);
  sourceFor(ref.tab).untag(ref.artifactId, bet.id);
  bet.components = bet.components.filter((c) => c.id !== refId);
  // Drop dangling dependency edges to the removed ref.
  for (const c of bet.components) c.dependsOn = c.dependsOn.filter((d) => d !== refId);
  bet.updatedAt = now();
  log(user.id, 'component.remove', bet.id, { refId, artifactId: ref.artifactId, note: 'untag only, artifact kept' });
  return bet;
}

export function setComponentPlan(
  betId: string,
  user: Principal,
  refId: string,
  patch: { start?: string; plannedReady?: string; dependsOn?: string[]; weight?: number },
): ComponentRef {
  const bet = requireEdit(betId, user);
  const ref = findRef(bet, refId);
  if (patch.dependsOn) {
    // Reject self/unknown/cyclic dependencies.
    for (const d of patch.dependsOn) {
      if (d === refId) throw new BetError('A component cannot depend on itself', 400);
      if (!bet.components.some((c) => c.id === d)) throw new BetError(`Unknown dependency ${d}`, 400);
    }
    if (wouldCycle(bet, refId, patch.dependsOn)) throw new BetError('Dependency would create a cycle', 400);
  }
  Object.assign(ref, patch);
  bet.updatedAt = now();
  log(user.id, 'component.plan', bet.id, { refId, fields: Object.keys(patch) });
  return ref;
}

function wouldCycle(bet: BigBet, refId: string, newDeps: string[]): boolean {
  const deps = new Map(bet.components.map((c) => [c.id, c.id === refId ? newDeps : c.dependsOn]));
  const seen = new Set<string>();
  const stack = [...newDeps];
  while (stack.length) {
    const n = stack.pop()!;
    if (n === refId) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    stack.push(...(deps.get(n) ?? []));
  }
  return false;
}

/** Owner override shown BESIDE the derived state (never replacing it). Audited. */
export function setOverride(betId: string, user: Principal, refId: string, override: Omit<StatusOverride, 'by' | 'at'> | null): ComponentRef {
  const bet = requireEdit(betId, user);
  const ref = findRef(bet, refId);
  ref.override = override ? { ...override, by: user.id, at: now() } : undefined;
  bet.updatedAt = now();
  log(user.id, 'component.override', bet.id, { refId, note: override?.note ?? '(cleared)' });
  return ref;
}

/**
 * Advance a component's lifecycle through the tab's governed flow (build →
 * certify/promote/publish/deploy/go-live). The source REJECTS a planner actor
 * for any READY transition — the human-ships invariant. Re-derives nothing here;
 * status is read live from the artifact afterwards.
 */
export function advanceComponent(betId: string, user: Actor, refId: string, to: Lifecycle): ComponentRef {
  const bet = requireView(betId, user); // view-scope: even a domain Builder can ship
  const ref = findRef(bet, refId);
  sourceFor(ref.tab).advance(ref.artifactId, to, user);
  log(user.id, 'component.advance', bet.id, { refId, to, actorKind: user.kind ?? 'human' });
  return ref;
}

// ----------------------------------------------------------- internal hook ---

/** Internal: fetch without scope (planner + value roll-up across bets). */
export function _getBetRaw(betId: string): BigBet | null {
  return state().bets.get(betId) ?? null;
}
export function _allBets(): BigBet[] {
  return [...state().bets.values()];
}
