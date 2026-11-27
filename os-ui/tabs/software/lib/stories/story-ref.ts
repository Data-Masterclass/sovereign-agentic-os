/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder B - which story a commit is for, and "change without a story"
 * USER STORY: As a business owner I want every code change to name the user story it implements, and a developer's push
 *             that names none to be flagged as a change without a story, so nothing reaches users that nobody agreed.
 * ARCHITECTURE:
 *   - Pure, import-light (contracts only), so the receive hook, the build loop, the MCP push handler and the tests share
 *     ONE rule (spec section 5, "developer push").
 *   - A reference is either the `Story: US-3` trailer (several ids comma-separated, several trailer lines allowed) or a
 *     bracketed `[US-3]` / `[US-3/AC-2]` anywhere in the message. The OS's own commits put `[US-n]` in the subject (the
 *     commit path flattens notes into the subject line; see the plan's B notes), so both shapes count the same.
 *   - "Code" is every app-relative path outside `stories/` and the documentation (`docs/**` and top-level `*.md`). A
 *     reference only counts when it names a story the app has (`validStoryRefs`, the receive hook passes the agreed
 *     ids); the hook judges every pushed commit, not the union of messages (posthoc.ts `storylessShas`).
 *   - Ids are matched with fixed ASCII patterns (no catastrophic backtracking, bounded number length) and the message is
 *     cut at MESSAGE_LIMIT before matching: a commit message is author input, never trusted for size.
 */
import { APPS_DIR } from '@core/infra/repo-layout';
import { STORIES_DIR, STORY_TRAILER, type StoryId } from '@tabs/software/lib/app-builder-contracts';

/** Longest commit message (characters) the rules read; the rest is ignored. */
export const MESSAGE_LIMIT = 16_384;

const NUM = '[1-9][0-9]{0,5}';
const TRAILER_RE = new RegExp(`^\\s*${STORY_TRAILER}\\s*:\\s*(.+)$`, 'gim');
const ID_IN_TRAILER_RE = new RegExp(`\\bUS-(${NUM})\\b`, 'g');
const BRACKET_RE = new RegExp(`\\[US-(${NUM})(?:/AC-${NUM})?\\]`, 'g');

/** Every story id one commit message refers to, unique, in numeric order. */
export function storyRefsInMessage(message: string): StoryId[] {
  const msg = String(message ?? '').slice(0, MESSAGE_LIMIT);
  const out = new Set<number>();
  for (const m of msg.matchAll(TRAILER_RE)) for (const id of m[1].matchAll(ID_IN_TRAILER_RE)) out.add(Number(id[1]));
  for (const m of msg.matchAll(BRACKET_RE)) out.add(Number(m[1]));
  return [...out].sort((a, b) => a - b).map((n) => `US-${n}` as StoryId);
}

/**
 * The references in a message that name a story THIS app has (callers pass its agreed ids): a well-formed id alone
 * (`[US-99999]`) is not a reference to anything.
 */
export function validStoryRefs(message: string, known: ReadonlySet<string>): StoryId[] {
  return storyRefsInMessage(message).filter((id) => known.has(id));
}

/** The union over several messages (a push carries one per commit). */
export function storyRefsInMessages(messages: string[]): StoryId[] {
  const all = new Set<string>();
  for (const m of messages ?? []) for (const id of storyRefsInMessage(m)) all.add(id);
  return [...all].sort((a, b) => Number(a.slice(3)) - Number(b.slice(3))) as StoryId[];
}

/** `<APPS_DIR>/<slug>/x/y` → `x/y`; an app-relative path is returned unchanged (a leading `./` dropped). */
export function appRelativePath(path: string): string {
  const p = String(path ?? '');
  return p.startsWith(`${APPS_DIR}/`) ? p.split('/').slice(2).join('/') : p.replace(/^\.\//, '');
}

/** True for the living spec and documentation: never "code". */
export function isSpecOrDocPath(path: string): boolean {
  const p = appRelativePath(path);
  if (p === STORIES_DIR || p.startsWith(`${STORIES_DIR}/`)) return true;
  if (p.startsWith('docs/')) return true;
  return !p.includes('/') && /\.md$/i.test(p);
}

/** The changed paths that count as code (outside `stories/` and docs). */
export function codePaths(paths: string[]): string[] {
  return (paths ?? []).filter((p) => !isSpecOrDocPath(p));
}

/** The subject reference the OS puts on its own commits for these stories (`[US-3] [US-4]`). */
export function storyRefNote(ids: string[]): string {
  return [...new Set(ids)].filter((id) => new RegExp(`^US-${NUM}$`).test(id)).map((id) => `[${id}]`).join(' ');
}
