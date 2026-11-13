/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    `push_app_files` — the ONE documented verb for "code in Claude, push to the OS"
 * USER STORY: As an engineer coding in Claude I want one call that puts my files into my app's
 *             source tree in the OS's git, tells me the commit sha, whether anything changed, what
 *             the compile gate said, and where I can look at the result — and I want pushing the
 *             same files twice to make ONE commit, with me as the author (night-2 S6, S-US1).
 * ARCHITECTURE:
 *   - ONE SERVICE, TWO DOORS. This function is the service; the MCP tool and the UI route both
 *     call it, so the MCP/UI parity test compares two invocations of the SAME code — not two code
 *     paths that happen to agree today. It delegates straight to `commitToApp`, which is the one
 *     convergent commit step every front door already flows through.
 *   - THE GATE RUNS BEFORE THE WRITE. `commitToApp` compiles the MERGED tree and throws 422 with
 *     the diagnostics BEFORE anything is written — no git commit, no mirror write, no snapshot. A
 *     red gate therefore leaves the app byte-identical, and the diagnostics come back so the same
 *     turn can fix them.
 *   - IDEMPOTENT. `commitSubtree` commits only when the resulting tree hash changed, so an
 *     unchanged push returns `changed: false` with the existing head and creates no commit.
 *   - HONEST PREVIEW. The URL is `/apps/<slug>` for an app the OS serves itself, the runner's URL
 *     when a pod actually serves one, and `null` + a reason otherwise. Never a fabricated link.
 *   - Edit-scope gated: `getEditableAppForUser` (owner or in-domain admin) throws 403/404 exactly
 *     as every other edit path does, under the CALLER's identity.
 */
import 'server-only';
import type { CurrentUser } from '@core/kernel/auth';
import { getEditableAppForUser, serveModeOf, type App } from '@tabs/software/lib/apps';
import { commitToApp } from '@tabs/software/lib/server';
import type { ScaffoldFile } from '@tabs/software/lib/model';
import type { AppCommitOutcome } from '@tabs/software/lib/git-commit';
import { parseAppActions, type ActionParseIssue } from '@tabs/software/lib/app-actions';

export type PushAppFilesInput = {
  appId: string;
  files: ScaffoldFile[];
  message?: string;
  /** `mcp:push_app_files` or `ui:software/push`; recorded on the commit. */
  surface?: string;
  requestId?: string;
};

export type PushAppFilesResult = {
  appId: string;
  slug: string;
  /** The commit sha in the domain repository, or null when git did not record it (reason given). */
  commit: string | null;
  /** False ⇒ the push was a no-op: identical bytes, no new commit. */
  changed: boolean;
  /** The compile gate's outcome, verbatim — `gated: false` when the shape cannot be checked. */
  gate: { gated: boolean; ok?: boolean; reason?: string };
  /** Where to look at the result, or null with `previewNote` saying why there is nowhere yet. */
  previewUrl: string | null;
  previewNote: string | null;
  /** The declared-action parse issues, so a malformed `actions.yml` is never silently dropped. */
  actionIssues: ActionParseIssue[];
  /** The audited commit line, including the git note (sha, or why it was not recorded). */
  detail: string;
  /** The git outcome in full, for a caller that wants the domain and path. */
  git?: AppCommitOutcome;
};

/** The honest served location of an app, or null + the reason there is not one yet. */
export function previewLocation(app: Pick<App, 'slug' | 'serveMode' | 'spec' | 'deploy'>): { url: string | null; note: string | null } {
  const mode = serveModeOf(app);
  if (mode === 'spec') {
    const hasSpec = !!app.spec && Array.isArray(app.spec.tabs) && app.spec.tabs.length > 0;
    return hasSpec
      ? { url: `/apps/${app.slug}`, note: null }
      : { url: null, note: 'This is a declarative app with no AppSpec tabs yet — author the spec (set_app_spec) and it is served immediately at /apps/' + app.slug + '.' };
  }
  if (mode === 'runtime') return { url: `/apps/${app.slug}`, note: null };
  const served = app.deploy?.previewUrl ?? null;
  return served
    ? { url: served, note: null }
    : {
        url: null,
        note:
          'This app is set to serve a container image. The OS does not build images, so nothing is served until an image you published is set and the runner provisions it — start a preview (start_preview) to provision it.',
      };
}

/**
 * Push files into the app's source tree. The compile gate runs first; a red gate throws 422 with
 * the diagnostics and writes nothing. Returns the commit, whether anything changed, the gate
 * result and where to look.
 */
export async function pushAppFiles(input: PushAppFilesInput, user: CurrentUser): Promise<PushAppFilesResult> {
  const files = Array.isArray(input.files) ? input.files : [];
  if (files.length === 0) {
    const err = new Error('push_app_files needs at least one file ({ path, content }).') as Error & { status?: number };
    err.status = 400;
    throw err;
  }
  for (const f of files) {
    if (!f || typeof f.path !== 'string' || !f.path.trim() || typeof f.content !== 'string') {
      const err = new Error('Every file needs a non-empty `path` and a string `content`.') as Error & { status?: number };
      err.status = 400;
      throw err;
    }
  }
  // Edit-scope gate under the CALLER's identity (403/404 exactly as the other edit paths).
  const app = await getEditableAppForUser(input.appId, user);
  const message = String(input.message ?? '').trim() || `push ${files.length} file${files.length === 1 ? '' : 's'}`;

  const { app: after, step, git } = await commitToApp(app.id, user, files, message, {
    action: 'push_app_files',
    surface: input.surface,
    requestId: input.requestId,
  });

  const preview = previewLocation(after);
  const { issues } = parseAppActions(files);
  return {
    appId: after.id,
    slug: after.slug,
    commit: git && git.ok && git.recorded ? git.sha : null,
    changed: git && git.ok && git.recorded ? git.changed : false,
    gate: step.gate ?? { gated: false, ok: true, reason: 'no gate result recorded' },
    previewUrl: preview.url,
    previewNote: preview.note,
    actionIssues: issues,
    detail: step.detail,
    git,
  };
}
