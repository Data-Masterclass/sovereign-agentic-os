/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       kernel policy
 * FEATURE:    App Builder (W0) - the global go-live rule table: who reviews going live in Prod, per scope
 * USER STORY: As an admin I want one table that says who must review an app going live in each scope (My: nobody,
 *             Domain: a domain admin of that domain, Company: an admin), and I want "nobody approves their own
 *             go-live" to be a fact no setting can change.
 * ARCHITECTURE:
 *   - PURE (no I/O). Spec section 9. Workstream F adds the store (`go-live-rules-store.ts`) and wires
 *     `currentGoLiveRules()` to it; the signatures here stay as they are. Until then it returns the defaults.
 *   - A row's reviewer is satisfied by that role OR ANY HIGHER ONE (builder < domain_admin < admin). Below admin
 *     the reviewer must also belong to the app's domain: a domain admin of another domain does not satisfy a
 *     Domain row. Admin satisfies every row in every domain. Roles are read from the user record at decision time
 *     by the caller and passed in; nothing here caches a role.
 *   - The requester is NEVER an eligible reviewer, whatever the row says (not configurable). With reviewer `none`
 *     the go-live is auto-approved, but `canReview` still refuses the requester (there is nothing to review).
 *   - A missing row fails CLOSED to an admin review. Rules decide WHO reviews; they never skip a gate (checks,
 *     scans and unreviewed changes are checked by the callers).
 */
import { roleAtLeast, type Role } from '@core/kernel/session';
import type { Visibility } from '@core/kernel/artifact-model';

export type GoLiveKind = 'app' | 'agent';
export type GoLiveScope = 'my' | 'domain' | 'company';
export type Reviewer = 'none' | 'builder' | 'domain_admin' | 'admin';
export type GoLiveRule = { kind: GoLiveKind; scope: GoLiveScope; reviewer: Reviewer };

export const GO_LIVE_KINDS: readonly GoLiveKind[] = ['app', 'agent'];
export const GO_LIVE_SCOPES: readonly GoLiveScope[] = ['my', 'domain', 'company'];
export const REVIEWERS: readonly Reviewer[] = ['none', 'builder', 'domain_admin', 'admin'];

/** The defaults of spec section 9. `agent` rows exist so the table is complete; their enforcement is wired later. */
export const DEFAULT_GO_LIVE_RULES: readonly GoLiveRule[] = Object.freeze([
  { kind: 'app', scope: 'my', reviewer: 'none' },
  { kind: 'app', scope: 'domain', reviewer: 'domain_admin' },
  { kind: 'app', scope: 'company', reviewer: 'admin' },
  { kind: 'agent', scope: 'my', reviewer: 'none' },
  { kind: 'agent', scope: 'domain', reviewer: 'domain_admin' },
  { kind: 'agent', scope: 'company', reviewer: 'admin' },
] as const);

/** A go-live request: what goes live, in which scope and domain, and who asked. */
export type GoLiveRequest = { kind: GoLiveKind; scope: GoLiveScope; domain: string; requestedBy: string };
/** A person who might review: their id, CURRENT role and the domains they belong to (from the user record). */
export type GoLiveUser = { id: string; role: Role; domains: readonly string[] };

export type GoLiveDecision = {
  rule: GoLiveRule;
  reviewer: Reviewer;
  /** `true` only for reviewer `none`: the request is approved without a review (gates still apply). */
  autoApprove: boolean;
  reason: string;
};

export type ReviewVerdict = { ok: true } | { ok: false; reason: string };

/** Personal → my, Shared → domain, Certified → company. */
export function scopeOfVisibility(v: Visibility): GoLiveScope {
  return v === 'Certified' ? 'company' : v === 'Shared' ? 'domain' : 'my';
}

function ruleFor(rules: readonly GoLiveRule[], kind: GoLiveKind, scope: GoLiveScope): GoLiveRule {
  return rules.find((r) => r.kind === kind && r.scope === scope) ?? { kind, scope, reviewer: 'admin' };
}

const REVIEWER_LABEL: Record<Exclude<Reviewer, 'none'>, string> = {
  builder: 'a builder',
  domain_admin: 'a domain admin',
  admin: 'an admin',
};

/** Who must review going live for this kind/scope. A missing row is an admin review (fail closed). */
export function goLiveDecision(rules: readonly GoLiveRule[], kind: GoLiveKind, scope: GoLiveScope, domain: string): GoLiveDecision {
  const rule = ruleFor(rules, kind, scope);
  const missing = !rules.some((r) => r.kind === kind && r.scope === scope);
  if (rule.reviewer === 'none') {
    return { rule, reviewer: 'none', autoApprove: true, reason: `${kind} go-live in ${scope} scope needs no review (checks and scans still apply)` };
  }
  const where = rule.reviewer === 'admin' ? '' : ` of domain '${domain}' (or anyone with a higher role)`;
  return {
    rule,
    reviewer: rule.reviewer,
    autoApprove: false,
    reason: `${kind} go-live in ${scope} scope needs a review by ${REVIEWER_LABEL[rule.reviewer]}${where}${missing ? ' (no rule is configured for this scope, so an admin reviews)' : ''}`,
  };
}

/** May `reviewer` approve `req`? Role at least the row's reviewer, in the app's domain below admin, never the requester. */
export function canReview(rules: readonly GoLiveRule[], req: GoLiveRequest, reviewer: GoLiveUser): ReviewVerdict {
  if (reviewer.id === req.requestedBy) return { ok: false, reason: 'nobody approves their own go-live' };
  const d = goLiveDecision(rules, req.kind, req.scope, req.domain);
  if (d.reviewer === 'none') return { ok: false, reason: `no review is needed: ${d.reason}` };
  if (!roleAtLeast(reviewer.role, d.reviewer)) return { ok: false, reason: `${d.reason}; your role is ${reviewer.role}` };
  if (reviewer.role !== 'admin' && !reviewer.domains.includes(req.domain)) {
    return { ok: false, reason: `${d.reason}; you are not a member of domain '${req.domain}'` };
  }
  return { ok: true };
}

/**
 * When nobody except the requester could review, the request stays pending with this message (spec section 9).
 * `candidates` are the active users the caller looked up; null when at least one other person is eligible or no
 * review is needed.
 */
export function noEligibleReviewer(rules: readonly GoLiveRule[], req: GoLiveRequest, candidates: readonly GoLiveUser[]): string | null {
  const d = goLiveDecision(rules, req.kind, req.scope, req.domain);
  if (d.reviewer === 'none') return null;
  return candidates.some((u) => canReview(rules, req, u).ok) ? null : 'no other eligible reviewer; an admin can change the rule';
}

/**
 * The rule table in force. Workstream F replaces the body with the store read (Platform → Go-live rules); until
 * then the defaults. Async so the store can be async without a signature change.
 */
export async function currentGoLiveRules(): Promise<GoLiveRule[]> {
  return DEFAULT_GO_LIVE_RULES.map((r) => ({ ...r }));
}
