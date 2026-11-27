/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder A - move an app's record-only epics and stories into story files, in one commit
 * USER STORY: As the owner of an app designed before the App Builder I want my epics and stories to appear in the
 *             Stories view the first time I open it, honestly marked as drafts without tested criteria, and nothing lost.
 * ARCHITECTURE:
 *   - Spec section 3.4. `migrateEpicsToFiles(appId, user)` renders `App.epics` to files in ONE commit with
 *     `OS-Source: migration`: each epic becomes `EP-<n>`, each story `US-<n>` (numbered in record order), `state: draft`,
 *     zero criteria (so its light is `untested`); the free-text `acceptance`, the legacy per-story spec lists and the
 *     legacy ids go to the story's Notes. `App.epics` stays on the record untouched (read-only from now on).
 *   - IDEMPOTENT: nothing happens when the stories subtree already has files, when its history already holds a migration
 *     commit (a later deletion of every story file is a person's decision, not a reason to re-import), or when the record
 *     has no epics. Called by the Stories view on first open (an editor's explicit PUT) and by `design_software`.
 *   - Text that would not survive the strict format is made safe, never dropped silently: line breaks in one-line fields
 *     become spaces, `**` is removed from the story line, `##`/`###` lines in descriptions become `####`, and anything
 *     over a limit is cut with a visible "(cut)" marker.
 */
import 'server-only';
import { APPS_DIR } from '@core/infra/repo-layout';
import type { CurrentUser } from '@core/kernel/auth';
import { assertAppBuilderEnabled } from '@core/kernel/app-builder-flag';
import { config } from '@core/kernel/config';
import { logPath } from '@core/infra/git-store';
import type { EpicDoc, EpicId, StoryDoc, StoryId } from '@tabs/software/lib/app-builder-contracts';
import { STORIES_DIR } from '@tabs/software/lib/app-builder-contracts';
import type { App, AppEpic, AppStory } from '@tabs/software/lib/apps';
import { epicPath, renderEpicFile, renderStoryFile, SPEC_LIMITS, storyPath, validateEpicDoc, validateStoryDoc, type SpecFile } from '@tabs/software/lib/stories/files';
import { specSourceOf } from '@tabs/software/lib/stories/history';
import { mutateSpec, resolveSpecApp, SpecValidationError } from '@tabs/software/lib/stories/store';

export type MigrationResult =
  | { migrated: true; sha: string; epics: number; stories: number }
  | { migrated: false; reason: 'already-files' | 'already-migrated' | 'nothing-to-migrate'; sha?: string };

const CUT = ' (cut)';

function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - CUT.length)).trimEnd() + CUT;
}

function cutBytes(s: string, max: number): string {
  const enc = new TextEncoder();
  if (enc.encode(s).length <= max) return s;
  let out = s;
  while (enc.encode(out + CUT).length > max) out = out.slice(0, Math.floor(out.length * 0.9));
  return out.trimEnd() + CUT;
}

const singleLine = (v: unknown, max: number): string => cut(String(v ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim(), max);
const storyPart = (v: unknown): string => singleLine(String(v ?? '').replace(/\*\*/g, ''), SPEC_LIMITS.role);
const block = (v: unknown, max: number): string =>
  cutBytes(
    String(v ?? '')
      .replace(/\r\n?/g, '\n')
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
      .replace(/^(#{2,3}) /gm, '#### ')
      .trim(),
    max,
  );

/** The legacy record's epics as story files (pure; numbered EP-1…, US-1… in record order). */
export function legacyEpicsToFiles(epics: AppEpic[]): { files: SpecFile[]; epics: number; stories: number } {
  const files: SpecFile[] = [];
  let storyNo = 0;
  epics.forEach((e: AppEpic, i: number) => {
    const id = `EP-${i + 1}` as EpicId;
    const epic: Omit<EpicDoc, 'path'> = {
      id,
      title: singleLine(e.title, SPEC_LIMITS.title) || 'Untitled epic',
      description: block(e.description, SPEC_LIMITS.description),
      requirements: {
        technical: block(e.requirements?.technical, SPEC_LIMITS.requirement),
        ux: block(e.requirements?.ux, SPEC_LIMITS.requirement),
        governance: block(e.requirements?.governance, SPEC_LIMITS.requirement),
      },
    };
    const path = epicPath(id, epic.title);
    const epicIssues = validateEpicDoc(epic, path);
    if (epicIssues.length) throw new SpecValidationError(epicIssues);
    files.push({ path, content: renderEpicFile(epic) });
    for (const s of (e.stories ?? []) as AppStory[]) {
      storyNo += 1;
      const sid = `US-${storyNo}` as StoryId;
      const story: Omit<StoryDoc, 'path'> = {
        id: sid,
        epic: id,
        title: singleLine(s.title, SPEC_LIMITS.title) || 'Untitled story',
        asA: storyPart(s.asA),
        iWant: storyPart(s.iWant),
        soThat: storyPart(s.soThat),
        state: 'draft',
        criteria: [],
        notes: block(legacyNotes(e, s), SPEC_LIMITS.notes),
      };
      const sp = storyPath({ path }, sid, story.title);
      const issues = validateStoryDoc(story, sp);
      if (issues.length) throw new SpecValidationError(issues);
      files.push({ path: sp, content: renderStoryFile(story) });
    }
  });
  return { files, epics: epics.length, stories: storyNo };
}

function legacyNotes(e: AppEpic, s: AppStory): string {
  const parts: string[] = [];
  if (String(s.acceptance ?? '').trim()) parts.push(`Acceptance (from the app record, not yet written as criteria):\n${String(s.acceptance).trim()}`);
  const list = (label: string, xs: unknown) => {
    const items = Array.isArray(xs) ? xs.map((x) => String(x ?? '').trim()).filter(Boolean) : [];
    if (items.length) parts.push(`${label}:\n${items.map((x) => `- ${x}`).join('\n')}`);
  };
  list('Features', s.spec?.features);
  list('Non-functional requirements', s.spec?.nfrs);
  list('Rules', s.spec?.rules);
  parts.push(`Migrated from the app record (epic ${String(e.id ?? '').slice(0, 60)}, story ${String(s.id ?? '').slice(0, 60)}).`);
  return parts.join('\n\n');
}

/** True when the stories subtree's history already holds the migration commit. */
async function alreadyMigrated(app: Pick<App, 'domain' | 'slug'>): Promise<boolean> {
  const { entries } = await logPath(app.domain, `${APPS_DIR}/${app.slug}/${STORIES_DIR}`, { reposDir: config.reposDir, limit: 200 });
  return entries.some((e) => specSourceOf(e) === 'migration');
}

/** `migrateEpicsToFiles(appId, user)` (plan, workstream A; spec 3.4). Editors only; idempotent. */
export async function migrateEpicsToFiles(appId: string, user: CurrentUser): Promise<MigrationResult> {
  assertAppBuilderEnabled();
  const app = await resolveSpecApp(appId, user, 'edit');
  if (!Array.isArray(app.epics) || app.epics.length === 0) return { migrated: false, reason: 'nothing-to-migrate' };
  if (await alreadyMigrated(app)) return { migrated: false, reason: 'already-migrated' };
  const state: { skipped: MigrationResult | null } = { skipped: null };
  const out = await mutateSpec(
    app,
    user,
    async (base) => {
      if (base.files.some((f) => f.path !== `${STORIES_DIR}/README.md`)) {
        state.skipped = { migrated: false, reason: 'already-files', sha: base.sha };
        return { files: base.files, result: null };
      }
      const legacy = legacyEpicsToFiles(app.epics);
      return { files: [...base.files, ...legacy.files], result: legacy };
    },
    { source: 'migration', message: `migrate ${app.epics.length} epic(s) from the app record`, asPlatform: true },
  );
  if (state.skipped || !out.result) return state.skipped ?? { migrated: false, reason: 'already-files', sha: out.sha };
  return { migrated: true, sha: out.sha, epics: out.result.epics, stories: out.result.stories };
}

/** How many record-only epics the app still has to migrate (0 once its stories are files or it was migrated). */
export function legacyEpicCount(app: Pick<App, 'epics'>, specHasFiles: boolean): number {
  return specHasFiles ? 0 : Array.isArray(app.epics) ? app.epics.length : 0;
}
