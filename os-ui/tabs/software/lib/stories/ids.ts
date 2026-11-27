/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder A - server-assigned ids for epics, stories and acceptance criteria
 * USER STORY: As a tester I want a criterion id like `US-3/AC-2` to mean one criterion forever, so a test tagged with it
 *             never silently starts proving a different requirement.
 * ARCHITECTURE:
 *   - Spec section 3.1: `EP-<n>`, `US-<n>` (app-unique) and `AC-<n>` (unique within its story) are assigned by the OS,
 *     never by a model or a client. The next number is the highest one SEEN plus one: the ids in the tree, plus every
 *     id the caller passes in `seen` (the store adds the ids it finds in the stories' git history, so an id deleted at
 *     the top of the range is not handed out again within that history window).
 *   - Pure. Concurrency (two creates at once) is the store's job: it allocates under one per-app lock.
 */
import type { CriterionId, EpicId, StoryId } from '@tabs/software/lib/app-builder-contracts';
import { CRITERION_ID_RE, EPIC_ID_RE, SPEC_LIMITS, STORY_ID_RE, idNumber } from '@tabs/software/lib/stories/files';

function next(ids: Iterable<string>, re: RegExp, prefix: string): string {
  let max = 0;
  for (const id of ids) if (re.test(id)) max = Math.max(max, idNumber(id));
  if (max >= SPEC_LIMITS.maxIdNumber) throw Object.assign(new Error(`no ${prefix} id left (the highest is ${prefix}-${max})`), { status: 409 });
  return `${prefix}-${max + 1}`;
}

export function nextEpicId(spec: { epics: { id: string }[] }, seen: Iterable<string> = []): EpicId {
  return next([...spec.epics.map((e) => e.id), ...seen], EPIC_ID_RE, 'EP') as EpicId;
}

export function nextStoryId(spec: { stories: { id: string }[] }, seen: Iterable<string> = []): StoryId {
  return next([...spec.stories.map((s) => s.id), ...seen], STORY_ID_RE, 'US') as StoryId;
}

export function nextCriterionId(story: { criteria: { id: string }[] }, seen: Iterable<string> = []): CriterionId {
  return next([...story.criteria.map((c) => c.id), ...seen], CRITERION_ID_RE, 'AC') as CriterionId;
}

/** Ids of one kind found in a list of app-relative story paths (history: a path carries its id). */
export function idsInPaths(paths: Iterable<string>): { epics: EpicId[]; stories: StoryId[] } {
  const epics = new Set<EpicId>();
  const stories = new Set<StoryId>();
  for (const p of paths) {
    const e = /(?:^|\/)(EP-[1-9][0-9]{0,5})(?:-[^/]*)?\//.exec(p);
    if (e) epics.add(e[1] as EpicId);
    const s = /\/(US-[1-9][0-9]{0,5})(?:-[^/]*)?\.md$/.exec(p);
    if (s) stories.add(s[1] as StoryId);
  }
  return { epics: [...epics], stories: [...stories] };
}

/** Criterion ids found in a story file's text (history: any version of the file). */
export function criterionIdsIn(content: string): CriterionId[] {
  const out = new Set<CriterionId>();
  for (const m of String(content ?? '').matchAll(/^### (AC-[1-9][0-9]{0,5})\b/gm)) out.add(m[1] as CriterionId);
  return [...out];
}
