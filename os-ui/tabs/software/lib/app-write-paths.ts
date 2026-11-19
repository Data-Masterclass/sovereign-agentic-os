/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    The forbidden-paths rule for app files — one list, one check, every write door
 * USER STORY: As the OS I want a caller's app files to be refused on the same paths whichever door
 *             they arrive through (`push_app_files`, the `commit` tool, the builder, an import), so
 *             no door is a way around the rule.
 * ARCHITECTURE:
 *   - PURE (no `server-only`), so the builder's reply parser (`builder/prompts.ts`) can use it as
 *     well as the server doors (`push-app-files.ts`, `platform-mcp.ts`, `app/api/apps/import`).
 *   - The OS's own writes into `.app/` (the acceptance record, the decisions seed) are added by
 *     the OS after the caller's files are checked, so they never pass through here.
 *   - `app-write-paths.test.ts` proves every entry is refused at every door.
 */

/**
 * Dotfiles an app may NOT push. `.app/` is the OS's own metadata lane inside the app tree, and a
 * CI/forge directory is a claim about infrastructure that does not exist (the night-2 S1 purge
 * removed exactly these from the scaffolds — a push must not put them back).
 */
const FORBIDDEN_PREFIXES = ['.app/', '.forgejo/', '.github/', '.git/', '.gitea/', 'node_modules/'] as const;

/** A path that is a plain dotfile at the root (`.env`, `.npmrc`) — a secret or a registry config. */
const FORBIDDEN_ROOT_DOTFILES = ['.env', '.env.local', '.env.production', '.npmrc', '.netrc', '.gitconfig'] as const;

/** The lists, read-only, so the tests can walk every entry. */
export const APP_WRITE_FORBIDDEN_PREFIXES: readonly string[] = FORBIDDEN_PREFIXES;
export const APP_WRITE_FORBIDDEN_ROOT_FILES: readonly string[] = FORBIDDEN_ROOT_DOTFILES;

/** Why a caller may not write this app path, or null when the forbidden-paths rule allows it. */
export function forbiddenAppPathReason(path: string): string | null {
  const p = path.trim();
  const lower = p.toLowerCase();
  const forbidden = FORBIDDEN_PREFIXES.find((pre) => lower === pre.slice(0, -1) || lower.startsWith(pre));
  if (forbidden) {
    return (
      `'${p}' is not pushable: '${forbidden}' is reserved. ` +
      (forbidden === '.app/'
        ? "The `.app/` lane is the OS's own metadata inside the app tree."
        : 'There is no CI runner, image builder or registry in the OS, so a forge or CI directory would describe infrastructure that does not exist.')
    );
  }
  if ((FORBIDDEN_ROOT_DOTFILES as readonly string[]).includes(lower)) {
    return `'${p}' is not pushable: it is a credential or registry file. Secrets never live in an app's source tree.`;
  }
  return null;
}

/** Refuse (typed 400) a changeset that names any forbidden path. Entries without a string path are
 *  left to the door's own shape validation. */
export function assertNoForbiddenAppPaths(files: readonly { path?: unknown }[] | null | undefined): void {
  for (const f of files ?? []) {
    if (!f || typeof f.path !== 'string') continue;
    const refused = forbiddenAppPathReason(f.path);
    if (refused) {
      const err = new Error(refused) as Error & { status?: number };
      err.status = 400;
      throw err;
    }
  }
}
