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
  type BigBetSolution,
  type ComponentRef,
  type InterplayRelation,
  type Lifecycle,
  type Principal,
  type ProblemStatement,
  type SolutionEdge,
  type StatusOverride,
  type Tab,
  type ValueBasis,
  BetError,
  INTERPLAY_RELATIONS,
  roleAtLeast,
} from './model.ts';
import { resolveArtifact, sourceFor } from './sources.ts';
import { canManageArtifact } from '../governance/edit-scope.ts';
import { osMirror } from '../infra/os-mirror.ts';
import { type ArtifactVersion, versionLog } from '../core/versioning.ts';

/**
 * State pinned to `globalThis` so it is a TRUE singleton across all Next.js
 * route-handler module instances — a bet created via `POST /api/big-bets` is
 * immediately visible to `GET /api/big-bets` (and to the pillar-dropdown query).
 * Same pattern as `lib/marketplace/store.ts` and `lib/agents/store.ts`.
 */
type BetsState = { bets: Map<string, BigBet>; audit: AuditEvent[]; seq: number; hydration: Promise<void> | null };
const STATE_KEY = Symbol.for('soa.bigbets.store');
function state(): BetsState {
  const g = globalThis as unknown as Record<symbol, BetsState | undefined>;
  if (!g[STATE_KEY]) g[STATE_KEY] = { bets: new Map(), audit: [], seq: 0, hydration: null };
  return g[STATE_KEY]!;
}

// Durable, per-artifact version history (reused across the OS). A bet's editable
// content is snapshotted on every meaningful update + on restore.
const versions = versionLog('big-bet');

// ---------------------------------------------------- durable mirror (best-effort) --
const mirror = osMirror({
  index: 'os-bigbets',
  createBody: {
    mappings: {
      properties: {
        id: { type: 'keyword' },
        owner: { type: 'keyword' },
        domain: { type: 'keyword' },
        name: { type: 'keyword' },
        status: { type: 'keyword' },
        pillarId: { type: 'keyword' },
        goLive: { type: 'date' },
        updatedAt: { type: 'date' },
        problem: { type: 'object', enabled: false },
        components: { type: 'object', enabled: false },
      },
    },
  },
});

function writeThrough(bet: BigBet): void {
  mirror.writeThrough(bet.id, bet);
}

/** The versioned slice of a big bet — all fields a user edits. */
function snapshotState(bet: BigBet): {
  name: string; problem: BigBet['problem']; solution?: string;
  targetValue: number; goLive: string; valueBasis: BigBet['valueBasis'];
  allocation: BigBet['allocation']; ownerDeclaredValue?: number;
  members: string[]; status: BigBet['status'];
  blueprint?: BigBetSolution;
} {
  return {
    name: bet.name,
    problem: bet.problem,
    solution: bet.solution,
    targetValue: bet.targetValue,
    goLive: bet.goLive,
    valueBasis: bet.valueBasis,
    allocation: bet.allocation,
    ownerDeclaredValue: bet.ownerDeclaredValue,
    members: [...bet.members],
    status: bet.status,
    // Deep-clone the solution blueprint so a restored snapshot is independent.
    blueprint: bet.blueprint ? structuredClone(bet.blueprint) : undefined,
  };
}

export async function ensureHydrated(): Promise<void> {
  const s = state();
  if (!s.hydration) s.hydration = Promise.all([hydrate(), versions.ensureHydrated()]).then(() => {});
  return s.hydration;
}

async function hydrate(): Promise<void> {
  const s = state();
  const docs = (await mirror.hydrate(2000)) ?? [];
  for (const bet of docs as BigBet[]) {
    if (bet && bet.id && !s.bets.has(bet.id)) s.bets.set(bet.id, bet);
  }
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

/** Test hook: wipe the registry + audit + version history. */
export function __resetBets(): void {
  const s = state();
  s.bets.clear();
  s.audit.length = 0;
  s.seq = 0;
  s.hydration = null;
  mirror.__reset();
  versions.__reset();
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

/** Who can EDIT the bet (its owner; Admin for cross-domain). */
export function canEdit(bet: BigBet, user: Principal): boolean {
  if (user.role === 'admin') return true;
  if (bet.crossDomain) return false; // cross-domain edits are Admin-only
  // Fail-closed edit-scope: owner, or domain_admin of the owning domain.
  return canManageArtifact(user, { owner: bet.owner, domain: bet.domain });
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
  pillarId?: string;
  metricId?: string;
  targetValue: number;
  goLive: string;
  domain?: string;
  crossDomain?: boolean;
  valueBasis?: ValueBasis;
  allocation?: AllocationMethod;
  members?: string[];
};

export function createBet(user: Principal, input: CreateBetInput): BigBet {
  // Builder+ create + own; a Creator may draft.
  if (!['creator', 'builder', 'domain_admin', 'admin'].includes(user.role)) {
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
  writeThrough(bet);
  log(user.id, 'bet.create', bet.id, { name: bet.name, pillarId: bet.pillarId });
  return bet;
}

// ------------------------------------------------------------------- read ----

/**
 * List bets the user may view. Archived bets (status === 'archived') are hidden
 * from the default working list — the owner or Admin can opt-in via `includeArchived`
 * to review, restore, or permanently delete them.
 */
export function listBets(user: Principal, opts: { includeArchived?: boolean } = {}): BigBet[] {
  return [...state().bets.values()]
    .filter((b) => canView(b, user) && (opts.includeArchived || b.status !== 'archived'))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getBet(betId: string, user: Principal): BigBet {
  return requireView(betId, user);
}

// ----------------------------------------------------------------- update ----

/**
 * The ONLY bet fields an edit may ever touch. The `Pick<>` in the signature is
 * compile-time only — at runtime an authenticated owner could otherwise PATCH raw
 * JSON that lands any key on the bet (domain/owner/crossDomain/id/components/…),
 * a mass-assignment escalation. So we filter against this whitelist at runtime and
 * validate each value. Never trust the client — the role gate (requireEdit) is
 * necessary but NOT sufficient; the field surface must be constrained too.
 */
const EDITABLE_BET_FIELDS = [
  'name', 'problem', 'solution', 'targetValue', 'goLive',
  'valueBasis', 'allocation', 'ownerDeclaredValue', 'members', 'status',
] as const;
const VALUE_BASES: ValueBasis[] = ['uplift', 'absolute', 'owner-declared'];
const ALLOCATIONS: AllocationMethod[] = ['manual', 'usage', 'equal'];
const BET_STATUSES: BigBet['status'][] = ['draft', 'active', 'shipped', 'archived'];

export function updateBet(
  betId: string,
  user: Principal,
  patch: Partial<BigBet>,
  opts: { note?: string } = {},
): BigBet {
  const bet = requireEdit(betId, user);
  const raw = patch as Record<string, unknown>;
  const clean: Partial<BigBet> = {};
  for (const k of EDITABLE_BET_FIELDS) {
    const v = raw[k];
    if (v === undefined) continue;
    switch (k) {
      case 'targetValue':
      case 'ownerDeclaredValue':
        if (typeof v !== 'number' || !Number.isFinite(v)) throw new BetError(`${k} must be a finite number`, 400);
        break;
      case 'valueBasis':
        if (!VALUE_BASES.includes(v as ValueBasis)) throw new BetError('valueBasis must be uplift | absolute | owner-declared', 400);
        break;
      case 'allocation':
        if (!ALLOCATIONS.includes(v as AllocationMethod)) throw new BetError('allocation must be manual | usage | equal', 400);
        break;
      case 'status':
        if (!BET_STATUSES.includes(v as BigBet['status'])) throw new BetError('status must be draft | active | shipped | archived', 400);
        // Promotion out of draft (active/shipped) is a Builder+ act — a Creator
        // may draft + archive their own bet but never self-activate it.
        if ((v === 'active' || v === 'shipped') && !roleAtLeast(user.role, 'builder')) {
          throw new BetError('Only a Builder or Admin can activate or ship a bet', 403);
        }
        break;
      case 'members':
        if (!Array.isArray(v) || v.some((m) => typeof m !== 'string')) throw new BetError('members must be a string array', 400);
        break;
    }
    (clean as Record<string, unknown>)[k] = v;
  }
  if (Object.keys(clean).length === 0) return bet; // no-op edit → no version churn
  // Snapshot the PRIOR state before overwriting so every meaningful edit is
  // restorable from the version history.
  versions.record(betId, user.id, snapshotState(bet), 'edit');
  Object.assign(bet, clean);
  if (clean.members) bet.members = [...new Set([bet.owner, ...clean.members])];
  bet.updatedAt = now();
  writeThrough(bet);
  log(user.id, 'bet.update', betId, { fields: Object.keys(clean), ...(opts.note ? { note: opts.note } : {}) });
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
  writeThrough(bet);
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
  // Solution blueprint: drop any interplay edges that reference the removed ref, and
  // clear the anchor if it WAS the removed ref (mirrors the dependsOn cleanup above).
  if (bet.blueprint) {
    bet.blueprint.edges = bet.blueprint.edges.filter((e) => e.from !== refId && e.to !== refId);
    if (bet.blueprint.anchorWorkflowRefId === refId) bet.blueprint.anchorWorkflowRefId = undefined;
    if (bet.blueprint.positions) delete bet.blueprint.positions[refId];
  }
  bet.updatedAt = now();
  writeThrough(bet);
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
  writeThrough(bet);
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

// --------------------------------------------------- solution blueprint ------
//
// The solution BLUEPRINT is the runtime interplay graph over a bet's components:
// ONE anchor workflow + interplay edges (consumes/produces/triggers/feeds/monitors)
// between ComponentRefs. Distinct from `dependsOn` (build order for the Gantt) —
// a separate array with separate semantics. All setters are edit-gated; reads are
// view-gated. The invariants (single anchor, anchor must be a knowledge/workflow
// ref, edges reference on-bet ref ids, no duplicate edges) are enforced HERE.

/** Ensure the blueprint object exists, returning it. Never serialized when empty. */
function ensureBlueprint(bet: BigBet): BigBetSolution {
  if (!bet.blueprint) bet.blueprint = { edges: [] };
  return bet.blueprint;
}

/**
 * Set (or move) the bet's anchor workflow. Invariant enforced in the store:
 * EXACTLY ONE component may carry `role:'anchor-workflow'`, and it MUST be a
 * `knowledge`-tab ref (workflows live in lib/knowledge). Pass a ComponentRef.id
 * OR an artifactId (a knowledge ref for that artifact must already be on the bet).
 * Passing an empty/undefined refId CLEARS the anchor.
 */
export function setBetWorkflow(betId: string, workflowRefIdOrArtifact: string | undefined, user: Principal): BigBet {
  const bet = requireEdit(betId, user);
  const bp = ensureBlueprint(bet);
  // Clear the anchor.
  if (!workflowRefIdOrArtifact) {
    for (const c of bet.components) if (c.role === 'anchor-workflow') c.role = 'component';
    bp.anchorWorkflowRefId = undefined;
    bet.updatedAt = now();
    writeThrough(bet);
    log(user.id, 'bet.solution.anchor', bet.id, { cleared: true });
    return bet;
  }
  // Resolve the target ref by ref-id first, then by artifactId.
  const ref =
    bet.components.find((c) => c.id === workflowRefIdOrArtifact) ??
    bet.components.find((c) => c.artifactId === workflowRefIdOrArtifact);
  if (!ref) throw new BetError(`No component on this bet matches '${workflowRefIdOrArtifact}'`, 404);
  if (ref.tab !== 'knowledge') {
    throw new BetError('The anchor workflow must be a knowledge (workflow) component', 400);
  }
  // Single-anchor invariant: demote any prior anchor, promote this one.
  for (const c of bet.components) if (c.role === 'anchor-workflow' && c.id !== ref.id) c.role = 'component';
  ref.role = 'anchor-workflow';
  bp.anchorWorkflowRefId = ref.id;
  bet.updatedAt = now();
  writeThrough(bet);
  log(user.id, 'bet.solution.anchor', bet.id, { refId: ref.id, artifactId: ref.artifactId });
  return bet;
}

/**
 * Wire an interplay edge between two of the bet's components. Validates: both refs
 * exist on THIS bet, the relation is valid, and the edge is not a duplicate (same
 * from/to/relation). `from`/`to` are ComponentRef ids, never artifactIds.
 */
export function wireComponents(
  betId: string,
  fromRefId: string,
  toRefId: string,
  relation: InterplayRelation,
  user: Principal,
): { bet: BigBet; edge: SolutionEdge } {
  const bet = requireEdit(betId, user);
  if (fromRefId === toRefId) throw new BetError('A component cannot wire to itself', 400);
  if (!INTERPLAY_RELATIONS.includes(relation)) {
    throw new BetError(`relation must be one of ${INTERPLAY_RELATIONS.join(' | ')}`, 400);
  }
  if (!bet.components.some((c) => c.id === fromRefId)) throw new BetError(`Unknown component ref '${fromRefId}'`, 404);
  if (!bet.components.some((c) => c.id === toRefId)) throw new BetError(`Unknown component ref '${toRefId}'`, 404);
  const bp = ensureBlueprint(bet);
  if (bp.edges.some((e) => e.from === fromRefId && e.to === toRefId && e.relation === relation)) {
    throw new BetError('That interplay edge already exists', 409);
  }
  const edge: SolutionEdge = {
    id: id('edge'),
    from: fromRefId,
    to: toRefId,
    relation,
    addedBy: user.id,
    addedAt: now(),
  };
  bp.edges.push(edge);
  bet.updatedAt = now();
  writeThrough(bet);
  log(user.id, 'bet.solution.wire', bet.id, { edgeId: edge.id, from: fromRefId, to: toRefId, relation });
  return { bet, edge };
}

/** Remove an interplay edge by id (no-op-safe: unknown id → 404). */
export function unwireComponents(betId: string, edgeId: string, user: Principal): BigBet {
  const bet = requireEdit(betId, user);
  const bp = bet.blueprint;
  if (!bp || !bp.edges.some((e) => e.id === edgeId)) throw new BetError(`Edge ${edgeId} not found on this bet`, 404);
  bp.edges = bp.edges.filter((e) => e.id !== edgeId);
  bet.updatedAt = now();
  writeThrough(bet);
  log(user.id, 'bet.solution.unwire', bet.id, { edgeId });
  return bet;
}

/**
 * Read the solution blueprint (view-gated): the anchor ref, the nodes (the bet's
 * ComponentRefs), the interplay edges, and the canvas positions. Returns empty
 * shapes when the bet has no blueprint yet — never null, so the UI can render a
 * blank canvas.
 */
export function getSolution(
  betId: string,
  user: Principal,
): { anchor: ComponentRef | null; nodes: ComponentRef[]; edges: SolutionEdge[]; positions: Record<string, { x: number; y: number }> } {
  const bet = requireView(betId, user);
  const bp = bet.blueprint;
  const anchor = bp?.anchorWorkflowRefId ? bet.components.find((c) => c.id === bp.anchorWorkflowRefId) ?? null : null;
  return {
    anchor,
    nodes: [...bet.components],
    edges: bp ? [...bp.edges] : [],
    positions: bp?.positions ? { ...bp.positions } : {},
  };
}

/** Persist canvas node positions (edit-gated). Only positions for on-bet refs are kept. */
export function savePositions(
  betId: string,
  positions: Record<string, { x: number; y: number }>,
  user: Principal,
): BigBet {
  const bet = requireEdit(betId, user);
  const bp = ensureBlueprint(bet);
  const valid: Record<string, { x: number; y: number }> = {};
  for (const [refId, p] of Object.entries(positions ?? {})) {
    if (!bet.components.some((c) => c.id === refId)) continue; // ignore stray ids
    if (typeof p?.x !== 'number' || typeof p?.y !== 'number' || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      throw new BetError(`Position for '${refId}' must be finite {x,y} numbers`, 400);
    }
    valid[refId] = { x: p.x, y: p.y };
  }
  bp.positions = valid;
  bet.updatedAt = now();
  writeThrough(bet);
  log(user.id, 'bet.solution.positions', bet.id, { count: Object.keys(valid).length });
  return bet;
}

/** Owner override shown BESIDE the derived state (never replacing it). Audited. */
export function setOverride(betId: string, user: Principal, refId: string, override: Omit<StatusOverride, 'by' | 'at'> | null): ComponentRef {
  const bet = requireEdit(betId, user);
  const ref = findRef(bet, refId);
  ref.override = override ? { ...override, by: user.id, at: now() } : undefined;
  bet.updatedAt = now();
  writeThrough(bet);
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
  writeThrough(bet);
  log(user.id, 'component.advance', bet.id, { refId, to, actorKind: user.kind ?? 'human' });
  return ref;
}

// ------------------------------------------------ archive / delete / versions --

/**
 * Archive a bet: a reversible soft-hide (status → 'archived'). Edit-scoped —
 * only the owner or an Admin may archive, exactly like editing it. The record
 * and its history are retained; the bet leaves the working list until unarchived.
 */
export function archiveBet(betId: string, user: Principal): BigBet {
  const bet = requireEdit(betId, user);
  bet.status = 'archived';
  bet.updatedAt = now();
  writeThrough(bet);
  log(user.id, 'bet.archive', betId);
  return bet;
}

/** Restore an archived bet back into the working list (edit-scoped). */
export function unarchiveBet(betId: string, user: Principal): BigBet {
  const bet = requireEdit(betId, user);
  bet.status = 'active';
  bet.updatedAt = now();
  writeThrough(bet);
  log(user.id, 'bet.unarchive', betId);
  return bet;
}

/**
 * Permanently delete a bet + its version history (edit-scoped, irreversible).
 * The API route confirms intent; this is the hard delete once confirmed.
 */
export function deleteBet(betId: string, user: Principal): void {
  const bet = requireEdit(betId, user);
  state().bets.delete(bet.id);
  mirror.deleteThrough(bet.id);
  versions.purge(bet.id);
  log(user.id, 'bet.delete', betId);
}

/** Version history for a bet, newest first (view-scoped). */
export function listBetVersions(betId: string, user: Principal): ArtifactVersion[] {
  requireView(betId, user);
  return versions.list(betId);
}

/**
 * Restore a prior version of a bet's editable content. Restore is itself
 * auditable + reversible: the CURRENT state is snapshotted as a new version
 * first, THEN the chosen version's fields are applied. Edit-scoped.
 */
export function restoreBetVersion(betId: string, user: Principal, version: number): BigBet {
  const bet = requireEdit(betId, user);
  const snap = versions.get(betId, version);
  if (!snap) throw new BetError(`Version ${version} not found`, 404);
  const s = snap.state as ReturnType<typeof snapshotState> | null;
  if (!s || typeof s.name !== 'string') throw new BetError(`Version ${version} has no restorable state`, 422);
  // Snapshot the live state first so the restore can itself be undone.
  versions.record(betId, user.id, snapshotState(bet), `restore of v${version}`);
  // Apply the snapshot's editable fields.
  bet.name = s.name;
  bet.problem = s.problem;
  bet.solution = s.solution;
  bet.targetValue = s.targetValue;
  bet.goLive = s.goLive;
  bet.valueBasis = s.valueBasis;
  bet.allocation = s.allocation;
  bet.ownerDeclaredValue = s.ownerDeclaredValue;
  if (Array.isArray(s.members)) bet.members = [...new Set([bet.owner, ...s.members])];
  bet.status = s.status;
  // Restore the solution blueprint too (undefined when the snapshot had none).
  bet.blueprint = s.blueprint ? structuredClone(s.blueprint) : undefined;
  bet.updatedAt = now();
  writeThrough(bet);
  log(user.id, 'bet.restore', betId, { version });
  return bet;
}

// ----------------------------------------------------------- internal hook ---

/** Internal: fetch without scope (planner + value roll-up across bets). */
export function _getBetRaw(betId: string): BigBet | null {
  return state().bets.get(betId) ?? null;
}
export function _allBets(): BigBet[] {
  return [...state().bets.values()];
}

/**
 * Internal: stamp (or clear) a bet's pillarId without going through the full
 * edit gate (used by the Strategy pillar store to keep the two-way index in
 * sync when it calls linkBet / unlinkBet). The bet's owner-edit gate does NOT
 * apply here — it is a governed back-reference, not a user-facing field edit.
 */
export function _setPillarId(betId: string, pillarId: string | undefined): void {
  const bet = state().bets.get(betId);
  if (!bet) return;
  bet.pillarId = pillarId;
  bet.updatedAt = now();
  writeThrough(bet);
}
