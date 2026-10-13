/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * The per-story SPECIFICATION (Design stage) + the honest BUILD CHECKLIST derivation
 * (Build stage). Pure and framework-free so the shape and the built-vs-pending rules
 * are unit-testable on their own.
 *
 * DESIGN produces, per user story (or the synthetic "General" scope), three lists that
 * together say what the story SHOULD do — shaped by the Design conversation, editable
 * directly:
 *
 *   • features — capabilities the story delivers ("Send a reminder email").
 *   • nfrs     — non-functional requirements ("Renders in under 200ms").
 *   • rules    — governance / business rules ("Writes are held for approval").
 *
 * The spec is ADDITIVE on AppStory (`spec?`), so a pre-spec app loads unchanged and
 * we only ever serialise it when the user actually authors one (byte-stable).
 *
 * BUILD then ticks each spec item against real build activity. We can only honestly
 * verify build state at STORY granularity — the build agent commits per story, not per
 * spec item — so an item is "built" iff its story is `done` (a Build run committed
 * changes for it). When the story is not done, EVERY item is pending; we never
 * fake-tick an item we cannot verify shipped. This is stated in the UI, not papered over.
 */

/** The three editable spec lists for a story (Design stage). Additive + nil-safe. */
export type StorySpec = {
  features: string[];
  nfrs: string[];
  rules: string[];
};

/** An empty spec — the canonical "no spec authored yet" value. */
export function emptySpec(): StorySpec {
  return { features: [], nfrs: [], rules: [] };
}

/** True when the spec has at least one item in any of its three lists. */
export function specHasContent(spec: StorySpec | null | undefined): boolean {
  if (!spec) return false;
  return (spec.features?.length ?? 0) + (spec.nfrs?.length ?? 0) + (spec.rules?.length ?? 0) > 0;
}

/** Total number of spec items across all three lists (0 when absent). */
export function specItemCount(spec: StorySpec | null | undefined): number {
  if (!spec) return 0;
  return (spec.features?.length ?? 0) + (spec.nfrs?.length ?? 0) + (spec.rules?.length ?? 0);
}

/**
 * Normalise an arbitrary/legacy spec payload into a clean StorySpec — trims items,
 * drops blanks, coerces non-arrays to []. A malformed payload can never widen the
 * shape or smuggle non-strings through. Returns `undefined` when nothing survives,
 * so the field stays absent (byte-stable) rather than an empty object.
 */
export function normalizeSpec(raw: unknown): StorySpec | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const clean = (v: unknown): string[] =>
    (Array.isArray(v) ? v : [])
      .filter((x): x is string => typeof x === 'string')
      .map((x) => x.trim())
      .filter(Boolean)
      .slice(0, 50);
  const spec: StorySpec = { features: clean(r.features), nfrs: clean(r.nfrs), rules: clean(r.rules) };
  return specHasContent(spec) ? spec : undefined;
}

/** The minimal story shape the checklist derivation reads. */
export type SpecStory = { spec?: StorySpec; status?: 'todo' | 'building' | 'done' };

/** One ticked-or-pending checklist row (Build stage). */
export type ChecklistItem = { kind: 'feature' | 'nfr' | 'rule'; text: string; built: boolean };

/** The whole per-story checklist + its honest built/total tally. */
export type StoryChecklist = { items: ChecklistItem[]; built: number; total: number };

/**
 * Derive the Build checklist for one story from its Design spec + its build status.
 *
 * HONESTY RULE: an item is `built` ONLY when the story is `done` — the sole signal we
 * can trust that a Build run committed code for this story. We cannot verify a single
 * feature/NFR/rule shipped independently, so we never fake a per-item tick; a
 * not-done story shows every item pending. (A story with no spec yields an empty
 * checklist — there is nothing to tick.)
 */
export function deriveStoryChecklist(story: SpecStory): StoryChecklist {
  const spec = story.spec;
  const built = story.status === 'done';
  const rows: ChecklistItem[] = [];
  for (const text of spec?.features ?? []) rows.push({ kind: 'feature', text, built });
  for (const text of spec?.nfrs ?? []) rows.push({ kind: 'nfr', text, built });
  for (const text of spec?.rules ?? []) rows.push({ kind: 'rule', text, built });
  return { items: rows, built: built ? rows.length : 0, total: rows.length };
}

/** The minimal epic shape for design-completeness checks + roll-ups. */
export type SpecEpic = { stories: SpecStory[] };

/** An epic-level roll-up of its stories' built-state (for the detail panel). */
export type EpicOverview = {
  /** Stories whose Build run committed (status === 'done'). */
  storiesBuilt: number;
  /** Total stories under the epic. */
  storiesTotal: number;
  /** Spec items built across the epic (sum of done stories' spec items). */
  itemsBuilt: number;
  /** Total spec items across the epic. */
  itemsTotal: number;
};

/** Roll up an epic's stories into an honest built-vs-total overview. */
export function deriveEpicOverview(epic: SpecEpic): EpicOverview {
  let storiesBuilt = 0;
  let itemsBuilt = 0;
  let itemsTotal = 0;
  const stories = epic.stories ?? [];
  for (const s of stories) {
    if (s.status === 'done') storiesBuilt += 1;
    const c = deriveStoryChecklist(s);
    itemsBuilt += c.built;
    itemsTotal += c.total;
  }
  return { storiesBuilt, storiesTotal: stories.length, itemsBuilt, itemsTotal };
}

/**
 * DESIGN-stage completion: every story across every epic has authored a spec (≥1 item).
 * An app with no stories is NOT design-complete (there is nothing specified yet).
 */
export function everyStoryHasSpec(epics: SpecEpic[]): boolean {
  const stories = epics.flatMap((e) => e.stories ?? []);
  if (stories.length === 0) return false;
  return stories.every((s) => specHasContent(s.spec));
}

/**
 * How many stories (across every epic) have NO authored spec — i.e. nothing to build
 * yet. This is exactly the count the Build stage names in its "add features & rules in
 * Design first" callout: 0 means every story is buildable; N means N stories are still
 * waiting on their Design spec.
 */
export function storiesMissingSpec(epics: SpecEpic[]): number {
  return epics.flatMap((e) => e.stories ?? []).filter((s) => !specHasContent(s.spec)).length;
}

// ------------------------------------------------- design-progress checklist --

/**
 * The richer epic/story shape the design PROGRESS checklist reads — the ladder is
 * Epics → Requirements (technical/ux/governance) → User stories → Features/NFRs/Rules.
 * All fields optional + nil-safe so a pre-spec app rolls up cleanly.
 */
export type LadderEpic = {
  requirements?: { technical?: string; ux?: string; governance?: string };
  stories?: SpecStory[];
};

/** One rung of the artifact ladder: what it is, whether it's done, and the honest tally. */
export type LadderRung = {
  key: 'epics' | 'requirements' | 'stories' | 'specs';
  label: string;
  /** A short teaching line for when this rung is the user's next step. */
  hint: string;
  done: boolean;
  /** How many of `total` are satisfied (e.g. 2 / 5 stories specified). 0/0 ⇒ not started. */
  count: number;
  total: number;
};

/** True when an epic's requirements block carries at least one non-empty field. */
function epicHasRequirements(e: LadderEpic): boolean {
  const r = e.requirements;
  return !!(r && ((r.technical ?? '').trim() || (r.ux ?? '').trim() || (r.governance ?? '').trim()));
}

/**
 * Roll the whole design up into the four-rung artifact ladder the Design stage shows as
 * a progress checklist. Each rung is honest: a rung is `done` only when there is real
 * content for it, and `count/total` shows how far along that rung the user is. This
 * teaches the ladder (what comes next) AND tracks it (what's left), so the user is never
 * left guessing which artifact to create.
 */
export function designLadder(epics: LadderEpic[]): LadderRung[] {
  const epicsTotal = epics.length;
  const epicsWithReqs = epics.filter(epicHasRequirements).length;
  const stories = epics.flatMap((e) => e.stories ?? []);
  const storiesSpecced = stories.filter((s) => specHasContent(s.spec)).length;
  return [
    {
      key: 'epics',
      label: 'Epics',
      hint: 'Break the app into a few big chunks of value.',
      done: epicsTotal > 0,
      count: epicsTotal,
      total: epicsTotal,
    },
    {
      key: 'requirements',
      label: 'Requirements',
      hint: 'For each epic, note its technical, UX and governance requirements.',
      done: epicsTotal > 0 && epicsWithReqs === epicsTotal,
      count: epicsWithReqs,
      total: epicsTotal,
    },
    {
      key: 'stories',
      label: 'User stories',
      hint: 'Add the user stories each epic delivers ("As a … I want … so that …").',
      done: stories.length > 0,
      count: stories.length,
      total: stories.length,
    },
    {
      key: 'specs',
      label: 'Features & rules',
      hint: 'For each story, list its features, non-functional requirements and rules.',
      done: stories.length > 0 && storiesSpecced === stories.length,
      count: storiesSpecced,
      total: stories.length,
    },
  ];
}
