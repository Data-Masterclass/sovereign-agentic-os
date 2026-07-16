/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Per-item ACCESS LEVEL model for the Simple builder's "What your team can use"
 * grants, and how the AGENT-SYSTEM-WIDE safety preset CAPS it.
 *
 * There are three plain access levels the author picks per grantable item:
 *
 *   read-only    → the item is queryable, never writable
 *   read+propose → writes are PROPOSED and held for a human in Governance
 *   read+write   → writes run directly, no approval (builder-only, gated elsewhere)
 *
 * These map 1:1 onto the existing {@link Capability} grant model — there is NO
 * parallel access model:
 *
 *   read-only    ↔ 'Read'
 *   read+propose ↔ 'Write-approval'
 *   read+write   ↔ 'Write-bounded'
 *
 * The whole agent system carries ONE safety posture — `system.safetyPreset`
 * (read-only · read-propose · read-bounded · full-in-scope). The per-item selector
 * must OBEY it: the system posture is the CEILING no item may exceed, and at the two
 * extremes it locks every item.
 *
 *   read-only     → CEILING read-only,    every item LOCKED at read-only
 *   read-propose  → CEILING read+propose,  default read+propose, downgrade-only
 *   read-bounded  → CEILING read+write,    default read+write,   downgrade-only
 *   full-in-scope → CEILING read+write,    every item LOCKED at read+write
 *
 * "Downgrade-only" = the author may pick any level at or BELOW the ceiling, never
 * above it — so a per-item choice can only ever NARROW the system posture, never
 * widen it. Governance stays intact: the grant options are still scoped to what the
 * team may actually access; this cap is a second, orthogonal bound.
 *
 * PURE + client-safe (no server-only / Next imports) so the SimpleBuilder UI and the
 * unit tests share the ONE source of truth.
 */
import type { Capability, SafetyPreset } from './system-schema.ts';

/** The three plain access levels, weakest → strongest. */
export type AccessLevel = 'read-only' | 'read-propose' | 'read-write';

/** Ordered weakest → strongest — the rank IS the array index. */
export const ACCESS_LEVELS: AccessLevel[] = ['read-only', 'read-propose', 'read-write'];

/** The short human label shown on each option / lock badge. */
export const ACCESS_LABELS: Record<AccessLevel, string> = {
  'read-only': 'Read-only',
  'read-propose': 'Read + propose',
  'read-write': 'Read + write',
};

const LEVEL_RANK: Record<AccessLevel, number> = {
  'read-only': 0,
  'read-propose': 1,
  'read-write': 2,
};

/** An access level ↔ the persisted grant {@link Capability} (the ONE grant model). */
const LEVEL_TO_CAPABILITY: Record<AccessLevel, Capability> = {
  'read-only': 'Read',
  'read-propose': 'Write-approval',
  'read-write': 'Write-bounded',
};

/** Map a plain access level onto the persisted grant capability. */
export function accessToCapability(level: AccessLevel): Capability {
  return LEVEL_TO_CAPABILITY[level];
}

/** Map a persisted grant capability back to a plain access level (Off/Blocked → read-only). */
export function capabilityToAccess(cap: Capability): AccessLevel {
  if (cap === 'Write-bounded') return 'read-write';
  if (cap === 'Write-approval') return 'read-propose';
  return 'read-only';
}

/**
 * How the system-wide `safetyPreset` bounds the per-item selector.
 *   • `ceiling`  — the strongest level any item may reach.
 *   • `default`  — the level a NEWLY-granted item takes (equals the ceiling — a new
 *                  grant adopts the full system posture; the author then downgrades).
 *   • `locked`   — true at the extremes (read-only / full-in-scope): every item is
 *                  fixed at the ceiling and the selector is disabled.
 *   • `reason`   — a short, honest sentence explaining WHY it is locked (empty when
 *                  not locked).
 */
export type AccessCap = {
  ceiling: AccessLevel;
  default: AccessLevel;
  locked: boolean;
  reason: string;
};

export function accessCap(preset: SafetyPreset): AccessCap {
  switch (preset) {
    case 'read-only':
      return {
        ceiling: 'read-only',
        default: 'read-only',
        locked: true,
        reason: 'The system is set to read-only — access is fixed for every item.',
      };
    case 'full-in-scope':
      return {
        ceiling: 'read-write',
        default: 'read-write',
        locked: true,
        reason: 'The system is set to full-in-scope — every item may write directly.',
      };
    case 'read-bounded':
      // Direct bounded writes are the posture — ceiling is read+write, downgradable.
      return { ceiling: 'read-write', default: 'read-write', locked: false, reason: '' };
    case 'read-propose':
    default:
      // The common middle default — propose is the ceiling; the author may only downgrade.
      return { ceiling: 'read-propose', default: 'read-propose', locked: false, reason: '' };
  }
}

/** The access levels offerable under a cap — every level at or below the ceiling. */
export function allowedAccessLevels(cap: AccessCap): AccessLevel[] {
  return ACCESS_LEVELS.filter((l) => LEVEL_RANK[l] <= LEVEL_RANK[cap.ceiling]);
}

/**
 * Clamp a desired access level to the cap. A locked cap forces the ceiling; an
 * unlocked cap allows anything at or below the ceiling and clamps anything above it
 * DOWN to the ceiling (never widening). This is the enforcement the selector applies
 * on every change and on initial display of an already-persisted (possibly stale)
 * grant.
 */
export function clampAccess(level: AccessLevel, cap: AccessCap): AccessLevel {
  if (cap.locked) return cap.ceiling;
  return LEVEL_RANK[level] > LEVEL_RANK[cap.ceiling] ? cap.ceiling : level;
}
