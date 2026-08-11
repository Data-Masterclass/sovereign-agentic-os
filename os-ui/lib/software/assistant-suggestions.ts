/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * The SOFTWARE STAGE-ASSISTANT SUGGESTION model — the pure, client-safe shapes and
 * apply-reducers the Define + Design stages use when a user clicks "Apply" on a
 * suggestion card returned by the governed assistant route
 * (`app/api/apps/[id]/assistant/route.ts`).
 *
 * The assistant only SUGGESTS — it never mutates an app. Applying a suggestion is a
 * LOCAL, deterministic transform of the current editor state (purpose text / context
 * grants / epics); the host then persists the result through the SAME governed path
 * (`patchAppDesign`). Keeping the transforms here (pure, no React / no server imports)
 * means both the UI and the unit tests share one source of truth, and Apply can never
 * "invent" a write the user didn't confirm.
 */

import {
  clampContextAccess,
  setGrant,
  type ContextAccess,
  type ContextAccessCap,
  type ContextGrants,
  type ContextKind,
} from '@/lib/core/context-grants';
import type { AppEpic, AppStory } from '@/lib/software/apps';
import { normalizeSpec, type StorySpec } from '@/lib/software/story-spec';
import { normalizeSuggestedDatasets, type SuggestedDataset } from '@/lib/software/data-plan';

export type { SuggestedDataset } from '@/lib/software/data-plan';

/** A single context-grant the assistant proposes: which kind + id, at what access. */
export type SuggestedGrant = {
  kind: ContextKind;
  id: string;
  /** The access the assistant proposes; clamped DOWN to the cap on apply (never widened). */
  access?: ContextAccess;
  /** A short, human reason the assistant gives for proposing it (shown on the card). */
  reason?: string;
};

/** An epic the assistant proposes (same shape the editor persists, id assigned on apply). */
export type SuggestedEpic = {
  title: string;
  description?: string;
  requirements?: Partial<AppEpic['requirements']>;
  stories?: SuggestedStory[];
};

/** A user story the assistant proposes (id assigned on apply). May carry its spec. */
export type SuggestedStory = {
  title: string;
  asA?: string;
  iWant?: string;
  soThat?: string;
  acceptance?: string;
  /** The story's spec, when the assistant drafts features/NFRs/rules alongside it. */
  spec?: Partial<StorySpec>;
};

/** Stories the assistant proposes for an EXISTING epic, referenced by its title. */
export type SuggestedStoriesForEpic = {
  /** The (case-insensitive) title of the epic these stories belong under. */
  epicTitle: string;
  stories: SuggestedStory[];
};

/** Requirements the assistant proposes for an EXISTING epic, referenced by its title. */
export type SuggestedEpicRequirements = {
  /** The (case-insensitive) title of the epic these requirements belong to. */
  epicTitle: string;
  requirements: Partial<AppEpic['requirements']>;
};

/** The structured suggestions a stage assistant reply may carry (all optional). */
export type StageSuggestions = {
  /** Define: an improved purpose sentence the user can accept into the purpose box. */
  improvedPurpose?: string;
  /** Define: context grants the assistant proposes (from the DLS-scoped available set). */
  suggestedGrants?: SuggestedGrant[];
  /** Design: whole epics (with optional stories) to auto-create. */
  suggestedEpics?: SuggestedEpic[];
  /** Design: stories to add under existing epics, referenced by title. */
  suggestedStories?: SuggestedStoriesForEpic[];
  /** Design: requirements (technical/ux/governance) to fill in on EXISTING epics. */
  suggestedEpicRequirements?: SuggestedEpicRequirements[];
  /**
   * Design (spec mode): the three spec lists proposed for the CURRENTLY-SELECTED
   * story — features, non-functional requirements and rules. The host folds them
   * into that story's spec on Apply (never a blind write). Partial: any list may
   * be omitted.
   */
  suggestedSpec?: Partial<StorySpec>;
  /**
   * Design (data plan): CREATE-NEW datasets the assistant proposes for the app's data
   * needs — one per entity ("employees", "cases") with an inferred schema and whether to
   * fill it empty (schema only) or with AI dummy rows. Distinct from `suggestedGrants`,
   * which BINDS an existing dataset; the host resolves each item server-side (create +
   * materialize + grant). See `data-plan.ts`.
   */
  suggestedDatasets?: SuggestedDataset[];
  /**
   * Test (Verify & Improve): concrete improvements the verifier drafted for built
   * stories/features that fell short of spec, plus scope-changing feedback. Each is
   * tied to a story; `kind` says whether it's a REBUILD (missed spec) or a DESIGN
   * change (new requirement). The host turns them into pending Build-tree items.
   */
  suggestedImprovements?: RawImprovementSuggestion[];
};

/** One improvement the Test verifier / feedback proposes (pre-normalisation). */
export type RawImprovementSuggestion = {
  /** 'rebuild' (built code missed spec) | 'design' (a new/changed requirement). */
  kind?: 'rebuild' | 'design';
  /** The exact story id this improvement targets. */
  storyId?: string;
  /** The feature index within that story, when feature-specific. */
  featureIndex?: number;
  /** A short human note: what to change. */
  note?: string;
};

/** A stage-assistant reply: markdown prose plus optional structured suggestions. */
export type StageAssistantReply = {
  message: string;
  suggestions: StageSuggestions;
};

// --------------------------------------------------------------- id helper ---

/** A short, collision-resistant id (mirrors SoftwareBuilder's `rid`). */
function rid(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

// ----------------------------------------------------- Define apply reducers --

/**
 * Apply an `improvedPurpose` suggestion. Deliberately a plain passthrough (trimmed):
 * the HOST shows it as a confirmable draft in the purpose box, never a blind
 * write-through — so this returns the text the box should adopt, and the user still
 * presses "Save purpose". Kept as a function so the contract is explicit + testable.
 */
export function applyPurposeSuggestion(purpose: string): string {
  return purpose.trim();
}

/**
 * Fold suggested grants into the current grants object, clamped to the cap. Pure —
 * returns a NEW grants object. An already-granted id is re-set to the (clamped)
 * suggested access; a null/omitted access defaults to the cap default. Unknown kinds
 * are ignored. This never removes an existing grant.
 */
export function applyGrantsSuggestion(
  grants: ContextGrants,
  suggested: SuggestedGrant[],
  cap: ContextAccessCap,
): ContextGrants {
  let next = grants;
  for (const g of suggested) {
    if (!g || typeof g.id !== 'string' || !g.id.trim()) continue;
    if (!(g.kind in next)) continue;
    const desired = clampContextAccess(g.access ?? cap.default, cap);
    next = setGrant(next, g.kind, g.id, desired, cap);
  }
  return next;
}

// ----------------------------------------------------- Design apply reducers --

/** Normalise a suggested story into a full, id'd AppStory (its spec folded in if drafted). */
function materializeStory(s: SuggestedStory): AppStory {
  const story: AppStory = {
    id: rid('story'),
    title: (s.title ?? '').trim(),
    asA: (s.asA ?? '').trim(),
    iWant: (s.iWant ?? '').trim(),
    soThat: (s.soThat ?? '').trim(),
    acceptance: (s.acceptance ?? '').trim(),
  };
  // A drafted spec rides along the story — normalised (trimmed, blanks dropped) so a
  // malformed suggestion can never widen the shape. Absent ⇒ field stays absent.
  const spec = s.spec ? normalizeSpec(s.spec) : undefined;
  if (spec) story.spec = spec;
  return story;
}

/** Normalise a suggested epic into a full, id'd AppEpic (its stories materialised too). */
function materializeEpic(e: SuggestedEpic): AppEpic {
  return {
    id: rid('epic'),
    title: (e.title ?? '').trim(),
    description: (e.description ?? '').trim(),
    requirements: {
      technical: (e.requirements?.technical ?? '').trim(),
      ux: (e.requirements?.ux ?? '').trim(),
      governance: (e.requirements?.governance ?? '').trim(),
    },
    stories: (e.stories ?? []).map(materializeStory),
  };
}

/**
 * Append suggested epics to the current list (each materialised with fresh ids).
 * Empty-titled suggestions are dropped. Pure — returns a NEW array; existing epics
 * are untouched (this CREATES, never overwrites).
 */
export function applyEpicsSuggestion(epics: AppEpic[], suggested: SuggestedEpic[]): AppEpic[] {
  const created = suggested.filter((e) => (e?.title ?? '').trim()).map(materializeEpic);
  return [...epics, ...created];
}

/**
 * Add suggested stories under EXISTING epics, matched by title (case-insensitive,
 * trimmed). Stories whose epic title matches no current epic are dropped (the host
 * surfaces that as a no-op rather than silently creating a new epic). Empty-titled
 * stories are dropped. Pure — returns a NEW epics array.
 */
export function applyStoriesSuggestion(
  epics: AppEpic[],
  suggested: SuggestedStoriesForEpic[],
): AppEpic[] {
  const byTitle = new Map<string, SuggestedStory[]>();
  for (const group of suggested) {
    const key = (group?.epicTitle ?? '').trim().toLowerCase();
    if (!key) continue;
    const rows = (group.stories ?? []).filter((s) => (s?.title ?? '').trim());
    if (rows.length === 0) continue;
    byTitle.set(key, [...(byTitle.get(key) ?? []), ...rows]);
  }
  if (byTitle.size === 0) return epics;
  return epics.map((epic) => {
    const add = byTitle.get(epic.title.trim().toLowerCase());
    if (!add || add.length === 0) return epic;
    return { ...epic, stories: [...epic.stories, ...add.map(materializeStory)] };
  });
}

/**
 * Fill in requirements (technical/ux/governance) on EXISTING epics, matched by title
 * (case-insensitive, trimmed). Only EMPTY requirement fields are filled — a field the
 * user already wrote is never overwritten. Epics that match no suggestion are untouched.
 * Pure — returns a NEW epics array.
 */
export function applyEpicRequirementsSuggestion(
  epics: AppEpic[],
  suggested: SuggestedEpicRequirements[],
): AppEpic[] {
  const byTitle = new Map<string, Partial<AppEpic['requirements']>>();
  for (const group of suggested) {
    const key = (group?.epicTitle ?? '').trim().toLowerCase();
    if (!key || !group.requirements) continue;
    byTitle.set(key, { ...byTitle.get(key), ...group.requirements });
  }
  if (byTitle.size === 0) return epics;
  return epics.map((epic) => {
    const add = byTitle.get(epic.title.trim().toLowerCase());
    if (!add) return epic;
    const keep = (existing: string, next: string | undefined): string =>
      existing.trim() ? existing : (next ?? '').trim();
    return {
      ...epic,
      requirements: {
        technical: keep(epic.requirements.technical, add.technical),
        ux: keep(epic.requirements.ux, add.ux),
        governance: keep(epic.requirements.governance, add.governance),
      },
    };
  });
}

/**
 * Fold a suggested spec into a story's existing spec — de-duplicated, appended (never
 * replacing what the user already wrote). Pure — returns a NEW StorySpec. A partial
 * suggestion (only features, say) leaves the other lists untouched.
 */
export function applySpecSuggestion(current: StorySpec | undefined, suggested: Partial<StorySpec>): StorySpec {
  const merge = (a: string[], b: string[] | undefined): string[] => {
    const seen = new Set(a.map((x) => x.toLowerCase()));
    const add = (b ?? []).map((x) => x.trim()).filter((x) => x && !seen.has(x.toLowerCase()));
    return [...a, ...add];
  };
  return {
    features: merge(current?.features ?? [], suggested.features),
    nfrs: merge(current?.nfrs ?? [], suggested.nfrs),
    rules: merge(current?.rules ?? [], suggested.rules),
  };
}

// ------------------------------------------------------ reply normalisation --

/**
 * Defensively normalise a raw parsed model reply (arbitrary JSON) into a
 * {@link StageAssistantReply}. Everything is optional and shape-guarded so a
 * malformed field degrades to "no suggestion of that kind" rather than throwing.
 * Used by BOTH the route (to shape its response) and could back a test.
 */
export function normalizeAssistantReply(raw: unknown, kinds: ContextKind[]): StageAssistantReply {
  const rec = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const message = str(rec.message).trim();

  const suggestions: StageSuggestions = {};

  const improved = str(rec.improvedPurpose).trim();
  if (improved) suggestions.improvedPurpose = improved;

  if (Array.isArray(rec.suggestedGrants)) {
    const kindSet = new Set(kinds);
    const grants = rec.suggestedGrants
      .map((g): SuggestedGrant | null => {
        if (!g || typeof g !== 'object') return null;
        const o = g as Record<string, unknown>;
        const kind = o.kind as ContextKind;
        const id = str(o.id).trim();
        if (!kindSet.has(kind) || !id) return null;
        const access = ['read-only', 'read-propose', 'read-write'].includes(str(o.access))
          ? (str(o.access) as ContextAccess)
          : undefined;
        return { kind, id, access, reason: str(o.reason).trim() || undefined };
      })
      .filter((g): g is SuggestedGrant => g !== null);
    if (grants.length) suggestions.suggestedGrants = grants;
  }

  if (Array.isArray(rec.suggestedEpics)) {
    const epics = rec.suggestedEpics
      .map((e): SuggestedEpic | null => {
        if (!e || typeof e !== 'object') return null;
        const o = e as Record<string, unknown>;
        const title = str(o.title).trim();
        if (!title) return null;
        const req = (o.requirements && typeof o.requirements === 'object' ? o.requirements : {}) as Record<string, unknown>;
        return {
          title,
          description: str(o.description).trim() || undefined,
          requirements: {
            technical: str(req.technical).trim() || undefined,
            ux: str(req.ux).trim() || undefined,
            governance: str(req.governance).trim() || undefined,
          },
          stories: Array.isArray(o.stories) ? o.stories.map(normalizeStory).filter((s): s is SuggestedStory => s !== null) : undefined,
        };
      })
      .filter((e): e is SuggestedEpic => e !== null);
    if (epics.length) suggestions.suggestedEpics = epics;
  }

  if (Array.isArray(rec.suggestedStories)) {
    const groups = rec.suggestedStories
      .map((g): SuggestedStoriesForEpic | null => {
        if (!g || typeof g !== 'object') return null;
        const o = g as Record<string, unknown>;
        const epicTitle = str(o.epicTitle).trim();
        if (!epicTitle || !Array.isArray(o.stories)) return null;
        const stories = o.stories.map(normalizeStory).filter((s): s is SuggestedStory => s !== null);
        if (stories.length === 0) return null;
        return { epicTitle, stories };
      })
      .filter((g): g is SuggestedStoriesForEpic => g !== null);
    if (groups.length) suggestions.suggestedStories = groups;
  }

  if (Array.isArray(rec.suggestedEpicRequirements)) {
    const groups = rec.suggestedEpicRequirements
      .map((g): SuggestedEpicRequirements | null => {
        if (!g || typeof g !== 'object') return null;
        const o = g as Record<string, unknown>;
        const epicTitle = str(o.epicTitle).trim();
        const req = (o.requirements && typeof o.requirements === 'object' ? o.requirements : {}) as Record<string, unknown>;
        const requirements: Partial<AppEpic['requirements']> = {};
        const t = str(req.technical).trim(); if (t) requirements.technical = t;
        const u = str(req.ux).trim(); if (u) requirements.ux = u;
        const gv = str(req.governance).trim(); if (gv) requirements.governance = gv;
        if (!epicTitle || (!requirements.technical && !requirements.ux && !requirements.governance)) return null;
        return { epicTitle, requirements };
      })
      .filter((g): g is SuggestedEpicRequirements => g !== null);
    if (groups.length) suggestions.suggestedEpicRequirements = groups;
  }

  if (rec.suggestedSpec && typeof rec.suggestedSpec === 'object') {
    const o = rec.suggestedSpec as Record<string, unknown>;
    const list = (v: unknown): string[] =>
      (Array.isArray(v) ? v : []).filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean);
    const spec: Partial<StorySpec> = {};
    const f = list(o.features); if (f.length) spec.features = f;
    const n = list(o.nfrs); if (n.length) spec.nfrs = n;
    const r = list(o.rules); if (r.length) spec.rules = r;
    if (spec.features || spec.nfrs || spec.rules) suggestions.suggestedSpec = spec;
  }

  const datasets = normalizeSuggestedDatasets(rec.suggestedDatasets);
  if (datasets) suggestions.suggestedDatasets = datasets;

  if (Array.isArray(rec.suggestedImprovements)) {
    const imps = rec.suggestedImprovements
      .map((raw): RawImprovementSuggestion | null => {
        if (!raw || typeof raw !== 'object') return null;
        const o = raw as Record<string, unknown>;
        const storyId = str(o.storyId).trim();
        const note = str(o.note).trim();
        if (!storyId || !note) return null;
        const kind = o.kind === 'design' ? 'design' : 'rebuild';
        const featureIndex = typeof o.featureIndex === 'number' && o.featureIndex >= 0 ? o.featureIndex : undefined;
        return { kind, storyId, note, featureIndex };
      })
      .filter((i): i is RawImprovementSuggestion => i !== null);
    if (imps.length) suggestions.suggestedImprovements = imps;
  }

  return { message, suggestions };
}

/** Shape-guard a raw {features,nfrs,rules} blob into a Partial<StorySpec> (or undefined). */
function normalizeSuggestedSpec(raw: unknown): Partial<StorySpec> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const list = (v: unknown): string[] =>
    (Array.isArray(v) ? v : []).filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean);
  const spec: Partial<StorySpec> = {};
  const f = list(o.features); if (f.length) spec.features = f;
  const n = list(o.nfrs); if (n.length) spec.nfrs = n;
  const r = list(o.rules); if (r.length) spec.rules = r;
  return spec.features || spec.nfrs || spec.rules ? spec : undefined;
}

function normalizeStory(raw: unknown): SuggestedStory | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const title = str(o.title).trim();
  if (!title) return null;
  return {
    title,
    asA: str(o.asA).trim() || undefined,
    iWant: str(o.iWant).trim() || undefined,
    soThat: str(o.soThat).trim() || undefined,
    acceptance: str(o.acceptance).trim() || undefined,
    spec: normalizeSuggestedSpec(o.spec),
  };
}
