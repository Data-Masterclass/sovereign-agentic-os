/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Write-back governance — the TWO modes (Connections golden path §5). How a write
 * is governed depends on whether a HUMAN IS PRESENT at run time:
 *
 *   A) In-tab assistants (human present): a Write-approval call PAUSES inline with
 *      a FULL PREVIEW (action · args · before/after diff · who · reason). An
 *      owner/Builder approves inline; "approve & remember" promotes it to an
 *      editable BOUNDED STANDING POLICY so identical calls stop prompting.
 *
 *   B) Autonomous agents (Agents tab, no human at run time): everything is
 *      PRE-authorized via a SAFETY PRESET (Read-only → Read+propose →
 *      Read+bounded-writes → Full-in-scope) + per-tool fine-tune, inheriting the
 *      domain default. Out-of-policy ⇒ BLOCK + log + queue for async Governance-
 *      inbox review — never an inline prompt (that would just stall the agent).
 *
 * The capability profile (compiled to OPA by `lib/capability-compiler.ts`) is the
 * ceiling for BOTH modes; a preset/standing-policy can only further restrict.
 * PURE module (no server-only): `lib/connections.ts` wires it to the secrets,
 * approvals queue and Langfuse trace.
 */

import { type Decision, type CapMode } from '../infra/capability-compiler.ts';

// =================================================================== Mode A =====

export type WritePreview = {
  action: string;
  args: Record<string, unknown>;
  /** Before/after field diff so an approver sees exactly what changes. */
  diff: { field: string; before: unknown; after: unknown }[];
  who: string;
  reason: string;
};

/** Build the full preview shown inline for a Write-approval pause (Mode A). */
export function buildPreview(input: {
  action: string;
  args: Record<string, unknown>;
  before?: Record<string, unknown>;
  who: string;
  reason: string;
}): WritePreview {
  const before = input.before ?? {};
  const diff: { field: string; before: unknown; after: unknown }[] = [];
  for (const [field, after] of Object.entries(input.args)) {
    if (field === 'id' || field === 'account') continue; // identifiers, not changes
    diff.push({ field, before: before[field] ?? null, after });
  }
  return { action: input.action, args: input.args, diff, who: input.who, reason: input.reason };
}

/**
 * A bounded STANDING POLICY created by "approve & remember": identical
 * (principal, tool) calls within `maxAmount` auto-allow without prompting. Editable
 * and revocable. In-process store (authoritative locally; a real deploy mirrors it
 * into the OPA bundle as a bounded rule).
 */
export type StandingPolicy = {
  id: string;
  principal: string;
  tool: string;
  /** Bound carried from the approved call (amount ≤ maxAmount). undefined ⇒ any. */
  maxAmount?: number;
  /** Argument the bound applies to. */
  boundArg: string;
  createdBy: string;
  createdAt: string;
};

type GovernanceStandingState = { standing: Map<string, StandingPolicy> };
const GOV_STANDING_KEY = Symbol.for('soa.governance.standing2');
function govStanding(): GovernanceStandingState {
  const g = globalThis as unknown as Record<symbol, GovernanceStandingState | undefined>;
  if (!g[GOV_STANDING_KEY]) g[GOV_STANDING_KEY] = { standing: new Map() };
  return g[GOV_STANDING_KEY]!;
}

function pid(): string {
  return `pol_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-4)}`;
}

/** "Approve & remember" → create/replace the bounded standing policy. */
export function rememberPolicy(input: {
  principal: string;
  tool: string;
  maxAmount?: number;
  boundArg?: string;
  createdBy: string;
}): StandingPolicy {
  const p: StandingPolicy = {
    id: pid(),
    principal: input.principal,
    tool: input.tool,
    maxAmount: input.maxAmount,
    boundArg: input.boundArg ?? 'amount',
    createdBy: input.createdBy,
    createdAt: new Date().toISOString(),
  };
  // One standing policy per (principal, tool): replace any prior.
  for (const [k, v] of govStanding().standing) if (v.principal === p.principal && v.tool === p.tool) govStanding().standing.delete(k);
  govStanding().standing.set(p.id, p);
  return p;
}

/** Does a standing policy already cover this call (so it auto-allows, no prompt)? */
export function matchStandingPolicy(principal: string, tool: string, args: Record<string, unknown> = {}): StandingPolicy | null {
  for (const p of govStanding().standing.values()) {
    if (p.principal !== principal || p.tool !== tool) continue;
    if (p.maxAmount === undefined) return p;
    const amount = Number(args[p.boundArg]);
    if (Number.isFinite(amount) && amount <= p.maxAmount) return p;
  }
  return null;
}

export function listStandingPolicies(principal?: string): StandingPolicy[] {
  return [...govStanding().standing.values()].filter((p) => (principal ? p.principal === principal : true));
}
export function revokeStandingPolicy(id: string): boolean {
  return govStanding().standing.delete(id);
}
/** Test seam. */
export function _clearStandingPolicies(): void {
  govStanding().standing.clear();
}

// =================================================================== Mode B =====

export type SafetyPreset = 'read-only' | 'read-propose' | 'read-bounded' | 'full-in-scope';
export const SAFETY_PRESETS: SafetyPreset[] = ['read-only', 'read-propose', 'read-bounded', 'full-in-scope'];

export const SAFETY_PRESET_HELP: Record<SafetyPreset, string> = {
  'read-only': 'Reads only. Any write is blocked and queued for review.',
  'read-propose': 'Reads run; writes are drafted (proposed) for a human to execute.',
  'read-bounded': 'Reads run; bounded writes auto-run within their limit; approval-writes are queued.',
  'full-in-scope': 'Everything the capability profile exposes runs; only out-of-scope is blocked.',
};

export type AutonomousEffect = 'allow' | 'propose' | 'block';
export type AutonomousDecision = { effect: AutonomousEffect; reason: string; queue: boolean };

/**
 * Resolve what an AUTONOMOUS agent may do for one tool call (Mode B). Inputs are
 * the profile decision (the ceiling, from the compiler) for this call + the tool's
 * capability mode + the agent's safety preset. The preset can only narrow the
 * profile. Out-of-policy ⇒ block + queue (async Governance-inbox review). Reads are
 * allowed only when the profile already exposes them.
 */
export function resolveAutonomous(
  preset: SafetyPreset,
  profile: Decision,
  toolMode: CapMode,
  isWrite: boolean,
): AutonomousDecision {
  // Profile is the ceiling: if it denies, the agent is blocked + queued for review.
  if (profile.effect === 'deny') {
    return { effect: 'block', reason: `out of policy: ${profile.reason}`, queue: true };
  }
  // Reads (profile allow, not a write): always permitted in every preset.
  if (!isWrite) {
    return { effect: 'allow', reason: 'read within policy', queue: false };
  }
  // Writes — governed by the preset.
  switch (preset) {
    case 'read-only':
      return { effect: 'block', reason: 'read-only preset: writes are blocked', queue: true };
    case 'read-propose':
      return { effect: 'propose', reason: 'read+propose preset: write drafted for a human to execute', queue: true };
    case 'read-bounded':
      if (profile.effect === 'allow' && toolMode === 'Write-bounded') {
        return { effect: 'allow', reason: 'bounded write within its limit', queue: false };
      }
      // Write-approval (profile requires_approval) or anything else ⇒ queue for review.
      return { effect: 'block', reason: 'read+bounded preset: approval-writes are queued for review', queue: true };
    case 'full-in-scope':
      if (profile.effect === 'allow') {
        return { effect: 'allow', reason: 'full-in-scope: within the capability profile', queue: false };
      }
      // Write-approval can't pause an autonomous run ⇒ async review.
      return { effect: 'block', reason: 'full-in-scope: approval-write queued for async review', queue: true };
    default:
      return { effect: 'block', reason: 'unknown preset', queue: true };
  }
}

/**
 * The domain default + per-agent + per-tool resolution of a safety preset. A new
 * agent inherits the (Admin-set) domain default; a Builder may override per agent
 * and fine-tune per tool. Returns the effective preset for one tool.
 */
type GovernancePresetState = { domainDefault: Map<string, SafetyPreset>; agentPreset: Map<string, SafetyPreset>; agentToolPreset: Map<string, SafetyPreset> };
const GOV_PRESETS_KEY = Symbol.for('soa.governance.presets');
function presets(): GovernancePresetState {
  const g = globalThis as unknown as Record<symbol, GovernancePresetState | undefined>;
  if (!g[GOV_PRESETS_KEY]) g[GOV_PRESETS_KEY] = { domainDefault: new Map(), agentPreset: new Map(), agentToolPreset: new Map() };
  return g[GOV_PRESETS_KEY]!;
}

export function setDomainDefaultPreset(domain: string, preset: SafetyPreset): void {
  presets().domainDefault.set(domain, preset);
}
export function setAgentPreset(agent: string, preset: SafetyPreset): void {
  presets().agentPreset.set(agent, preset);
}
export function setAgentToolPreset(agent: string, connection: string, tool: string, preset: SafetyPreset): void {
  presets().agentToolPreset.set(`${agent}:${connection}:${tool}`, preset);
}
export function _clearPresets(): void {
  const p = presets();
  p.domainDefault.clear();
  p.agentPreset.clear();
  p.agentToolPreset.clear();
}

/** Effective preset: per-tool fine-tune → per-agent → domain default → read-only. */
export function effectivePreset(agent: string, domain: string, connection: string, tool: string): SafetyPreset {
  const p = presets();
  return (
    p.agentToolPreset.get(`${agent}:${connection}:${tool}`) ??
    p.agentPreset.get(agent) ??
    p.domainDefault.get(domain) ??
    'read-only'
  );
}
