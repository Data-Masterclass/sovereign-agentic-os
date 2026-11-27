/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder - workstream A MCP tools (living spec: stories files, history, Stories view)
 * USER STORY: As an MCP client I want every App Builder action of workstream A to have an MCP twin of its UI action,
 *             governed exactly like the UI.
 * ARCHITECTURE:
 *   - EXTENSION POINT created empty by W0; owned by workstream A (plan: `get_stories`, `get_story_history`; handler for `design_software` (writes story files)).
 *   - `aTools`: NEW tools. index.ts wraps each with the App Builder guard (flag off ⇒ `app_builder_disabled`).
 *       `get_stories(appId, sha?)`   the living spec (epics, stories with criteria, file state and the light of the
 *                                    latest build when workstream B has recorded one) — the Stories view's read.
 *       `get_story_history(appId, id)` the versions of one epic or story: diff, author, source.
 *     Both are reads: the caller must be able to see the app (the same visibility rule as the UI).
 *   - `aHandlers.design_software`: for a `templateVersion: 2` app (index.ts `routeToAppBuilder`, flag on only) the
 *     design is written as STORY FILES in one commit (`OS-Source: mcp`), after the record-only epics are migrated once;
 *     `purpose` and `grants` still go through `patchAppDesign`. OPA `authorize()` first, then the store's edit scope.
 */
import type { McpTool } from '@core/mcp/server';
import type { AppBuilderHandler } from '@tabs/software/mcp/app-builder/types';
import { authorize } from '@core/infra/governed';
import { normalizeContextGrantsWithReport } from '@core/kernel/context-grants';
import { getAppForUser, patchAppDesign, withStatus } from '@tabs/software/lib/apps';
import { designEpicsToFiles, mutateSpec, resolveSpecApp, storiesView as storiesPayload, type DesignEpicInput } from '@tabs/software/lib/stories/store';
import { historyOf, seenIdsInHistory } from '@tabs/software/lib/stories/history';
import { migrateEpicsToFiles } from '@tabs/software/lib/stories/migrate';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export const aTools: McpTool[] = [
  {
    name: 'get_stories',
    description:
      "Read an App Builder app's LIVING SPEC: its epics and user stories as they are in git (apps/<slug>/stories/), each story with its acceptance criteria in Given/When/Then, its state (draft | agreed, decided by people), and its test light (green | partial | untested, derived from the latest build). Pass `sha` to read the spec at an earlier commit. `issues` lists files that do not parse (path, line, reason, fix). Read-only; the same visibility rule as the Stories view. Only for apps created from nextjs-web@2.",
    minRole: 'creator',
    tab: 'software',
    inputSchema: {
      type: 'object',
      properties: {
        appId: { type: 'string', description: 'App id from list_software.' },
        sha: { type: 'string', description: 'Optional full commit id to read the spec at.' },
      },
      required: ['appId'],
      examples: [{ appId: 'app_ab12cd' }],
    },
    call: async (user, args) => storiesPayload(str(args.appId), user, args.sha === undefined ? undefined : str(args.sha)),
  },
  {
    name: 'get_story_history',
    description:
      "The version history of ONE epic or story of an App Builder app: every commit that changed its file, newest first, with the unified diff, the author, and the source (ui | chat | mcp | git | migration; a developer's push is `git`) and the approved diff card when there was one. Secrets in the diff are redacted. Read-only; the same visibility rule as the Stories view.",
    minRole: 'creator',
    tab: 'software',
    inputSchema: {
      type: 'object',
      properties: {
        appId: { type: 'string', description: 'App id from list_software.' },
        id: { type: 'string', description: "An epic id ('EP-1') or a story id ('US-3') from get_stories." },
      },
      required: ['appId', 'id'],
      examples: [{ appId: 'app_ab12cd', id: 'US-3' }],
    },
    call: async (user, args) => {
      const app = await resolveSpecApp(str(args.appId), user, 'view');
      const { versions, truncated } = await historyOf({ domain: app.domain, slug: app.slug }, str(args.id));
      return { appId: app.id, id: str(args.id), versions, truncated };
    },
  },
];

/** `design_software` on a v2 app: epics become story files (one commit), purpose and grants go to the record. */
const designSoftware: AppBuilderHandler = async (user, args, app) => {
  const decision = await authorize(`user:${user.id}`, 'software_checks');
  if (!decision.allowed) throw withStatus(new Error(`OPA refused changing the design of ${app.name} (${decision.policy})`), 403);
  await getAppForUser(app.id, user);
  const target = await resolveSpecApp(app.id, user, 'edit');
  const migration = await migrateEpicsToFiles(app.id, user);
  const grantReport = args.grants !== undefined ? normalizeContextGrantsWithReport(args.grants) : null;
  if (args.purpose !== undefined || grantReport) {
    await patchAppDesign(app.id, user, {
      purpose: args.purpose !== undefined ? str(args.purpose) : undefined,
      grants: grantReport ? grantReport.grants : undefined,
    });
  }
  let written: { sha: string; changed: boolean; epics: string[]; stories: string[] } | null = null;
  if (args.epics !== undefined) {
    const seen = await seenIdsInHistory({ domain: target.domain, slug: target.slug });
    const out = await mutateSpec(
      target,
      user,
      async (base) => {
        const r = designEpicsToFiles(base, args.epics as DesignEpicInput[], seen);
        return { files: r.files, result: { epics: r.epics as string[], stories: r.stories } };
      },
      { source: 'mcp', message: 'design_software' },
    );
    written = { sha: out.sha, changed: out.changed, epics: out.result.epics, stories: out.result.stories };
  }
  const stories = await storiesPayload(app.id, user);
  return {
    appId: app.id,
    livingSpec: true,
    migration,
    ...(written ? { commit: written.sha, changed: written.changed, touched: { epics: written.epics, stories: written.stories } } : {}),
    epics: stories.epics,
    stories: stories.stories,
    issues: stories.issues,
    ...(grantReport && grantReport.notes.length > 0 ? { grantNotes: grantReport.notes } : {}),
    note:
      'This is an App Builder app: the design lives as story files in git (apps/<slug>/stories/). Ids are assigned by the OS. A story is built or verified only by its tests, never by a status you set; set state to agreed only for a requirement people have agreed.',
  };
};

export const aHandlers: Record<string, AppBuilderHandler> = { design_software: designSoftware };
