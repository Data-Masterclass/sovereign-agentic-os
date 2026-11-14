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

/** A single file may not exceed this. An app tree is text source; this is generous for one file. */
export const MAX_FILE_BYTES = 512 * 1024;
/** The whole changeset may not exceed this. */
export const MAX_PUSH_BYTES = 4 * 1024 * 1024;
/** How many files one push may carry. */
export const MAX_PUSH_FILES = 400;

/**
 * Dotfiles an app may NOT push. `.app/` is the OS's own metadata lane inside the app tree, and a
 * CI/forge directory is a claim about infrastructure that does not exist (the night-2 S1 purge
 * removed exactly these from the scaffolds — a push must not put them back).
 */
const FORBIDDEN_PREFIXES = ['.app/', '.forgejo/', '.github/', '.git/', '.gitea/', 'node_modules/'] as const;

/** A path that is a plain dotfile at the root (`.env`, `.npmrc`) — a secret or a registry config. */
const FORBIDDEN_ROOT_DOTFILES = ['.env', '.env.local', '.env.production', '.npmrc', '.netrc', '.gitconfig'] as const;

function bad(message: string): never {
  const err = new Error(message) as Error & { status?: number };
  err.status = 400;
  throw err;
}

/**
 * PATH DISCIPLINE + CAPS, enforced before anything is written (review M-2).
 *
 * A path must be repo-relative and stay inside the app's own subtree: no leading `/`, no `..`,
 * no empty or `.` segment, no backslash (a Windows-shaped path that `split('/')` would wave
 * through), no NUL, no absolute Windows drive. `package.json` may not introduce lifecycle
 * SCRIPTS, because a scaffold's `npm ci` would run them — an app pushes source, not build hooks.
 */
export function assertPushable(files: ScaffoldFile[]): void {
  if (files.length === 0) bad('push_app_files needs at least one file ({ path, content }).');
  if (files.length > MAX_PUSH_FILES) bad(`A push may carry at most ${MAX_PUSH_FILES} files; this one has ${files.length}.`);
  let total = 0;
  const seen = new Set<string>();
  for (const f of files) {
    if (!f || typeof f.path !== 'string' || !f.path.trim() || typeof f.content !== 'string') {
      bad('Every file needs a non-empty `path` and a string `content`.');
    }
    const p = f.path.trim();
    if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) bad(`'${p}' must be a path relative to the app root, not an absolute path.`);
    if (p.includes('\\')) bad(`'${p}' uses a backslash; app paths are '/'-separated.`);
    if (p.includes('\u0000')) bad('A file path may not contain a NUL byte.');
    const segments = p.split('/');
    if (segments.some((sg) => sg === '' || sg === '.' || sg === '..')) {
      bad(`'${p}' escapes the app's own tree (no '..', no empty or '.' segment). A push may only write under apps/<slug>/.`);
    }
    if (p.length > 400) bad(`'${p.slice(0, 60)}…' is too long for a repository path.`);
    if (seen.has(p)) bad(`'${p}' appears twice in this push; send each file once.`);
    seen.add(p);
    const lower = p.toLowerCase();
    const forbidden = FORBIDDEN_PREFIXES.find((pre) => lower === pre.slice(0, -1) || lower.startsWith(pre));
    if (forbidden) {
      bad(
        `'${p}' is not pushable: '${forbidden}' is reserved. ` +
          (forbidden === '.app/'
            ? "The `.app/` lane is the OS's own metadata inside the app tree."
            : 'There is no CI runner, image builder or registry in the OS, so a forge or CI directory would describe infrastructure that does not exist.'),
      );
    }
    if ((FORBIDDEN_ROOT_DOTFILES as readonly string[]).includes(lower)) {
      bad(`'${p}' is not pushable: it is a credential or registry file. Secrets never live in an app's source tree.`);
    }
    const bytes = Buffer.byteLength(f.content, 'utf8');
    if (bytes > MAX_FILE_BYTES) bad(`'${p}' is ${Math.round(bytes / 1024)} KiB; a single file may be at most ${MAX_FILE_BYTES / 1024} KiB.`);
    total += bytes;
    if (total > MAX_PUSH_BYTES) bad(`This push is over ${MAX_PUSH_BYTES / (1024 * 1024)} MiB in total; split it.`);
    if (lower === 'package.json') assertNoLifecycleScripts(p, f.content);
  }
}

/** `npm ci` runs lifecycle scripts, so a pushed `package.json` may not introduce them. */
const LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'prepublishOnly'] as const;

export function assertNoLifecycleScripts(path: string, content: string): void {
  let pkg: { scripts?: Record<string, unknown> };
  try {
    pkg = JSON.parse(content) as { scripts?: Record<string, unknown> };
  } catch {
    bad(`'${path}' is not valid JSON.`);
  }
  const scripts = pkg.scripts ?? {};
  const offending = LIFECYCLE_SCRIPTS.filter((k) => typeof scripts[k] === 'string' && String(scripts[k]).trim().length > 0);
  if (offending.length > 0) {
    bad(
      `'${path}' declares the install lifecycle script(s) ${offending.join(', ')}. ` +
        'A dependency install would execute them, so they are refused: an app pushes source, not build hooks.',
    );
  }
}

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
  // EXISTENCE FIRST (the F2-1 convention, pinned by `core/mcp/mcp-conformance.test.ts` X7): an
  // app the caller cannot SEE must answer `not_found` — the same answer an absent id gets — so
  // the visibility gate runs BEFORE any argument validation. Validating `files` first would have
  // told a stranger "your files are missing" about an app they have no right to know exists.
  const app = await getEditableAppForUser(input.appId, user);

  const files = Array.isArray(input.files) ? input.files : [];
  // REVIEW M-2: EVERY input rule is checked HERE, before `commitToApp` — because `commitToApp`
  // writes the mirror cache even when the git commit throws, so a tree refused downstream would
  // otherwise still land in the cache and come back from `read_app_files` as if it had been
  // accepted. Refuse first, write nothing.
  assertPushable(files);
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
