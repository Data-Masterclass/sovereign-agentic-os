/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder A - the Stories view's data: the payload it reads and the drafts its forms edit
 * USER STORY: As a business user editing a story I want what I type (one Given/When/Then per line) to be saved exactly,
 *             and an empty line to be ignored rather than become an empty criterion line.
 * ARCHITECTURE:
 *   - Pure `.ts` sibling of the view components (a test cannot import a `.tsx`): the GET /api/apps/[id]/stories payload
 *     type, the draft shapes of the story and epic forms, and the conversions draft <-> saved doc <-> PUT body. The
 *     server re-validates everything with the one parser; nothing here is a check, only shaping.
 *   - Status chip and light map to existing badge classes (`ok`, `warn`, `muted`) and always carry text, so colour is
 *     never the only signal.
 */
import type { EpicDoc, SpecIssue, SpecVersion, StoryDoc, StoryLight, StoryState, StoryStatus } from '@tabs/software/lib/app-builder-contracts';

export type StoryRow = StoryDoc & { status: StoryStatus; light: StoryLight };

/** GET /api/apps/[id]/stories. */
export type StoriesPayload = {
  appId: string;
  sha: string;
  epics: EpicDoc[];
  stories: StoryRow[];
  issues: SpecIssue[];
  truncated: boolean;
  canEdit: boolean;
  legacyEpics: number;
};

export type HistoryPayload = { id: string; versions: SpecVersion[] };

/** What a save tells the form: done, or the error (and the server's validation issues). */
export type SaveOutcome = { ok: true } | { ok: false; error: string; issues?: SpecIssue[] };

export type CriterionDraft = { id?: string; title: string; given: string; when: string; then: string };
export type StoryDraft = {
  id?: string;
  epic: string;
  title: string;
  asA: string;
  iWant: string;
  soThat: string;
  state: StoryState;
  criteria: CriterionDraft[];
  notes: string;
};
export type EpicDraft = { id?: string; title: string; description: string; technical: string; ux: string; governance: string };

const split = (s: string): string[] =>
  s
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

export const emptyCriterion = (): CriterionDraft => ({ title: '', given: '', when: '', then: '' });

export function newStoryDraft(epic: string): StoryDraft {
  return { epic, title: '', asA: '', iWant: '', soThat: '', state: 'draft', criteria: [], notes: '' };
}

export function storyDraftOf(s: StoryDoc): StoryDraft {
  return {
    id: s.id,
    epic: s.epic,
    title: s.title,
    asA: s.asA,
    iWant: s.iWant,
    soThat: s.soThat,
    state: s.state,
    criteria: s.criteria.map((c) => ({ id: c.id, title: c.title, given: c.given.join('\n'), when: c.when.join('\n'), then: c.then.join('\n') })),
    notes: s.notes,
  };
}

/** The PUT body for a story save. A criterion without an id is new (the server assigns `AC-<n>`). */
export function storyBody(d: StoryDraft, baseSha: string) {
  return {
    op: 'saveStory' as const,
    story: {
      ...(d.id ? { id: d.id } : {}),
      epic: d.epic,
      title: d.title.trim(),
      asA: d.asA.trim(),
      iWant: d.iWant.trim(),
      soThat: d.soThat.trim(),
      state: d.state,
      criteria: d.criteria.map((c) => ({ ...(c.id ? { id: c.id } : {}), title: c.title.trim(), given: split(c.given), when: split(c.when), then: split(c.then) })),
      notes: d.notes,
      ...(baseSha ? { baseSha } : {}),
    },
  };
}

export function newEpicDraft(): EpicDraft {
  return { title: '', description: '', technical: '', ux: '', governance: '' };
}

export function epicDraftOf(e: EpicDoc): EpicDraft {
  return { id: e.id, title: e.title, description: e.description, technical: e.requirements.technical, ux: e.requirements.ux, governance: e.requirements.governance };
}

export function epicBody(d: EpicDraft, baseSha: string) {
  return {
    op: 'saveEpic' as const,
    epic: {
      ...(d.id ? { id: d.id } : {}),
      title: d.title.trim(),
      description: d.description,
      requirements: { technical: d.technical, ux: d.ux, governance: d.governance },
      ...(baseSha ? { baseSha } : {}),
    },
  };
}

/** Badge class per light and per status (text is always shown next to it). */
export const LIGHT_BADGE: Record<StoryLight, string> = { green: 'badge ok', partial: 'badge warn', untested: 'badge muted' };
export const STATUS_BADGE: Record<StoryStatus, string> = { draft: 'badge muted', agreed: 'badge', built: 'badge warn', verified: 'badge ok' };

/** Stories grouped under their epic, in epic order; stories whose epic is unknown are returned apart. */
export function groupByEpic(p: Pick<StoriesPayload, 'epics' | 'stories'>): { epic: EpicDoc; stories: StoryRow[] }[] {
  return p.epics.map((epic) => ({ epic, stories: p.stories.filter((s) => s.epic === epic.id) }));
}

/** Lines of a unified diff with their kind, for an accessible rendering (+/- carry text, not only colour). */
export function diffLines(diff: string): { kind: 'add' | 'del' | 'hunk' | 'meta' | 'ctx'; text: string }[] {
  return diff
    .replace(/\n$/, '')
    .split('\n')
    .map((text) => ({
      kind: text.startsWith('+++') || text.startsWith('---') ? 'meta' : text.startsWith('@@') ? 'hunk' : text.startsWith('+') ? 'add' : text.startsWith('-') ? 'del' : 'ctx',
      text,
    }));
}
