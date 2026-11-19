/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * The OS-wide CONTEXT-GRANT model — a reusable, tab-agnostic core primitive
 * generalised from the Agents builder's per-artifact grant picker
 * (components/agents/GrantsRouting.tsx + lib/agents/access-levels.ts). Any tab
 * that lets a builder grant an artifact — Software, and Wave-2 tabs after it —
 * rides THIS shape; the React skin is components/core/ContextGrants.tsx.
 *
 * Pure + client-safe (no server-only / Next / lib-agents imports) so the picker
 * UI and the unit tests share the ONE source of truth. It deliberately mirrors
 * the Agents access-level semantics (read-only ↔ Read, read+propose ↔
 * Write-approval, read+write ↔ Write-bounded) WITHOUT importing the agent
 * module, keeping core free of tab-specific dependencies.
 *
 * A grant may target any of five CONTEXT KINDS — Connections · Data · Knowledge ·
 * Files · Metrics — at one of three ACCESS LEVELS, each capped by a system-level
 * SAFETY PRESET (the ceiling no grant may exceed). The cap logic is IDENTICAL to
 * the Agents builder so a grant means the same thing everywhere.
 */

/** The artifact kinds a context grant may target. A host tab offers a subset. */
export type ContextKind = 'connections' | 'data' | 'knowledge' | 'files' | 'metrics';

/** Every kind, in a stable display order. */
export const CONTEXT_KINDS: ContextKind[] = ['connections', 'data', 'knowledge', 'files', 'metrics'];

/** The short human label for each kind (title-cased for section headers). */
export const CONTEXT_KIND_LABELS: Record<ContextKind, string> = {
  connections: 'Connections',
  data: 'Data',
  knowledge: 'Knowledge',
  files: 'Files',
  metrics: 'Metrics',
};

/** The three plain access levels a grant can hold, weakest → strongest. */
export type ContextAccess = 'read-only' | 'read-propose' | 'read-write';

/** Ordered weakest → strongest — the rank IS the array index. */
export const CONTEXT_ACCESS_LEVELS: ContextAccess[] = ['read-only', 'read-propose', 'read-write'];

/** The short label shown on each option / lock badge. */
export const CONTEXT_ACCESS_LABELS: Record<ContextAccess, string> = {
  'read-only': 'Read',
  'read-propose': 'Read + propose',
  'read-write': 'Read + write',
};

const ACCESS_RANK: Record<ContextAccess, number> = {
  'read-only': 0,
  'read-propose': 1,
  'read-write': 2,
};

/** One granted artifact: its id plus the access the grantee holds on it. */
export type ContextGrant = { id: string; access: ContextAccess };

/** The full grants object — a per-kind list. This is the controlled value. */
export type ContextGrants = Record<ContextKind, ContextGrant[]>;

/** An empty grants object (every kind, no grants). The persisted default. */
export function emptyContextGrants(): ContextGrants {
  return { connections: [], data: [], knowledge: [], files: [], metrics: [] };
}

/** One thing the normaliser had to do to a caller's grant, as a user-facing line. */
export type GrantNote = string;

/**
 * Normalise a possibly-partial / legacy value into a full ContextGrants object,
 * so an app persisted BEFORE grants existed (undefined) still loads. Unknown
 * kinds are dropped; a missing kind defaults to an empty list.
 *
 * A grant whose `access` is MISSING takes the NARROWEST level (`read-only`) rather than
 * vanishing — see `normalizeContextGrantsWithReport`, which this delegates to.
 */
export function normalizeContextGrants(v: unknown): ContextGrants {
  return normalizeContextGrantsWithReport(v).grants;
}

/**
 * The same normalisation, plus a REPORT of everything it had to do — because a grant that
 * disappears without a word is a dead end.
 *
 * THE DEFECT THIS REPLACES (2026-11-19, driving the Software chain end to end). The filter
 * used to require a VALID `access` on every entry, so `{ id: 'ds_…' }` — the shape a model
 * writes when it reads `grants: { data: [{ id }] }` out of a worked example — was dropped
 * SILENTLY and the write still answered 200. The next door then refused with
 * "<id> is not granted to this app", which sends the author back to the grant door, which
 * drops it again: a loop with no error message anywhere in it.
 *
 * So:
 *   • `access` MISSING or empty  → `read-only`, the NARROWEST level, plus a note. An explicit
 *     grant is never silently ignored, and defaulting can only ever under-privilege.
 *   • `access` present but UNRECOGNISED → still dropped (the caller asked for something that
 *     does not exist and must not be quietly handed a different level), but now NAMED in the
 *     report so the caller can correct it.
 *   • no `id`, or not an object → dropped and named.
 *
 * Pure: no IO, no mutation of the input.
 */
export function normalizeContextGrantsWithReport(v: unknown): { grants: ContextGrants; notes: GrantNote[] } {
  const grants = emptyContextGrants();
  const notes: GrantNote[] = [];
  if (!v || typeof v !== 'object') return { grants, notes };
  const rec = v as Record<string, unknown>;
  for (const kind of CONTEXT_KINDS) {
    const arr = rec[kind];
    if (!Array.isArray(arr)) continue;
    for (const raw of arr) {
      if (!raw || typeof raw !== 'object') {
        notes.push(`${kind}: dropped a grant that is not an object`);
        continue;
      }
      const g = raw as Partial<ContextGrant>;
      if (typeof g.id !== 'string' || !g.id) {
        notes.push(`${kind}: dropped a grant with no "id"`);
        continue;
      }
      if (g.access === undefined || g.access === null || (g.access as string) === '') {
        grants[kind].push({ id: g.id, access: 'read-only' });
        notes.push(`${kind} ${g.id}: no "access" given — granted at the narrowest level, read-only`);
        continue;
      }
      if (!CONTEXT_ACCESS_LEVELS.includes(g.access)) {
        notes.push(
          `${kind} ${g.id}: dropped — "${String(g.access)}" is not an access level ` +
            `(use one of ${CONTEXT_ACCESS_LEVELS.join(', ')})`,
        );
        continue;
      }
      grants[kind].push({ id: g.id, access: g.access });
    }
  }
  return { grants, notes };
}

// ------------------------------------------------------------- Safety cap ------

/**
 * The system-level SAFETY PRESET — the ceiling a grant may not exceed. Mirrors the
 * Agents `SafetyPreset` semantics without importing it:
 *   • `read-only`     → ceiling read-only,  every grant LOCKED at read-only
 *   • `read-propose`  → ceiling read+propose, downgrade-only (the common default)
 *   • `read-write`    → ceiling read+write,   downgrade-only
 *   • `full-in-scope` → ceiling read+write,   every grant LOCKED at read+write
 */
export type ContextSafetyPreset = 'read-only' | 'read-propose' | 'read-write' | 'full-in-scope';

/** The resolved bound the picker applies (matches Agents `AccessCap`). */
export type ContextAccessCap = {
  /** The strongest access any grant may reach. */
  ceiling: ContextAccess;
  /** The access a newly-granted item takes (equals the ceiling). */
  default: ContextAccess;
  /** True at the extremes — every grant fixed at the ceiling, selector disabled. */
  locked: boolean;
  /** A short, honest reason WHY it is locked (empty when not locked). */
  reason: string;
};

/** How a safety preset bounds the per-item selector. */
export function contextAccessCap(preset: ContextSafetyPreset): ContextAccessCap {
  switch (preset) {
    case 'read-only':
      return {
        ceiling: 'read-only',
        default: 'read-only',
        locked: true,
        reason: 'Access is set to read-only — every grant is fixed at read.',
      };
    case 'full-in-scope':
      return {
        ceiling: 'read-write',
        default: 'read-write',
        locked: true,
        reason: 'Access is set to full-in-scope — every grant may write directly.',
      };
    case 'read-write':
      return { ceiling: 'read-write', default: 'read-write', locked: false, reason: '' };
    case 'read-propose':
    default:
      return { ceiling: 'read-propose', default: 'read-propose', locked: false, reason: '' };
  }
}

/** The access levels offerable under a cap — every level at or below the ceiling. */
export function allowedContextAccess(cap: ContextAccessCap): ContextAccess[] {
  return CONTEXT_ACCESS_LEVELS.filter((l) => ACCESS_RANK[l] <= ACCESS_RANK[cap.ceiling]);
}

/**
 * Clamp a desired access to the cap. A locked cap forces the ceiling; an unlocked
 * cap allows anything at or below the ceiling and clamps anything above it DOWN to
 * the ceiling (never widening) — the enforcement the selector applies on every
 * change AND on first display of an already-persisted (possibly stale) grant.
 */
export function clampContextAccess(level: ContextAccess, cap: ContextAccessCap): ContextAccess {
  if (cap.locked) return cap.ceiling;
  return ACCESS_RANK[level] > ACCESS_RANK[cap.ceiling] ? cap.ceiling : level;
}

// ------------------------------------------------------------- Mutation --------

/** The access a grant currently holds for `id` in `kind`, or 'read-only' if none. */
export function accessOf(grants: ContextGrants, kind: ContextKind, id: string): ContextAccess {
  return grants[kind].find((g) => g.id === id)?.access ?? 'read-only';
}

/** Whether `id` is granted at all in `kind`. */
export function isGranted(grants: ContextGrants, kind: ContextKind, id: string): boolean {
  return grants[kind].some((g) => g.id === id);
}

/**
 * Return a NEW grants object with `id` in `kind` set to `access` (clamped to the
 * cap). Passing `null` removes the grant. Pure — never mutates the input.
 */
export function setGrant(
  grants: ContextGrants,
  kind: ContextKind,
  id: string,
  access: ContextAccess | null,
  cap: ContextAccessCap,
): ContextGrants {
  const rest = grants[kind].filter((g) => g.id !== id);
  const next: ContextGrant[] =
    access === null ? rest : [...rest, { id, access: clampContextAccess(access, cap) }];
  return { ...grants, [kind]: next };
}

/**
 * Clamp EVERY grant to the cap (used when the preset tightens, so a stale
 * read+write grant under a now-read-only preset displays + persists as read).
 * Pure — returns a new object.
 */
export function clampAllGrants(grants: ContextGrants, cap: ContextAccessCap): ContextGrants {
  const out = emptyContextGrants();
  for (const kind of CONTEXT_KINDS) {
    out[kind] = grants[kind].map((g) => ({ id: g.id, access: clampContextAccess(g.access, cap) }));
  }
  return out;
}

/** Total grant count across all kinds — drives the "N granted" summary. */
export function grantCount(grants: ContextGrants): number {
  return CONTEXT_KINDS.reduce((n, k) => n + grants[k].length, 0);
}

/** Grant count for ONE kind — drives a per-kind "N granted" badge on collapsed rows. */
export function grantCountForKind(grants: ContextGrants, kind: ContextKind): number {
  return grants[kind]?.length ?? 0;
}
