/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder A - version history of one epic or story: every commit that changed it, with diff, author and source
 * USER STORY: As a business user I want to see who changed a story, when, from where (the OS, the chat, the MCP, a git
 *             push, the migration) and exactly what changed.
 * ARCHITECTURE:
 *   - Spec section 3.3: a version IS a commit touching the file. The commits that changed `apps/<slug>/stories/` are read
 *     with the git store's bounded path log; for each one the file carrying the id (the file name carries it: `US-3-…`,
 *     `EP-1-…/_epic.md`) is located at the commit and at its parent, so a story moved to another epic keeps its history.
 *   - The diff is the git store's `unifiedDiff` over the secret-scrubbed texts (the same scrub every version read uses).
 *   - SOURCE: `OS-Source` is trusted only on a commit the OS made (committer `Sovereign OS` and an `OS-Request-Id`
 *     trailer); anything else is `git`, the spec's rule "a push without OS-Source is git". A developer can forge those
 *     headers in their own commit; the source is a label for people, never an authorization input.
 *   - `seenIdsInHistory` gives the id allocator every epic/story id (from paths) and every criterion id of one story
 *     (from its file) found in the same bounded window, so a deleted id is not handed out again within it.
 */
import 'server-only';
import { COMMITTER, listTree, logPath, readBlob, scrubSecrets, unifiedDiff, type LogEntry } from '@core/infra/git-store';
import { config } from '@core/kernel/config';
import type { CurrentUser } from '@core/kernel/auth';
import { assertAppBuilderEnabled } from '@core/kernel/app-builder-flag';
import type { SpecSource, SpecVersion } from '@tabs/software/lib/app-builder-contracts';
import { STORIES_DIR } from '@tabs/software/lib/app-builder-contracts';
import { EPIC_ID_RE, STORY_ID_RE } from '@tabs/software/lib/stories/files';
import { criterionIdsIn, idsInPaths } from '@tabs/software/lib/stories/ids';

/** Most versions one history read returns, and how many commits of the stories subtree it examines. */
export const HISTORY_LIMIT = 50;
export const SEEN_WINDOW = 100;

const OS_SOURCES: ReadonlySet<SpecSource> = new Set(['ui', 'chat', 'mcp', 'migration']);

/** Where a commit came from (see the header). Pure. */
export function specSourceOf(entry: Pick<LogEntry, 'committer' | 'trailers'>): SpecSource {
  const t = entry.trailers ?? {};
  const fromOs = entry.committer?.email === COMMITTER.email && Boolean(t['OS-Request-Id']);
  if (!fromOs) return 'git';
  const s = t['OS-Source'] as SpecSource | undefined;
  if (s && OS_SOURCES.has(s)) return s;
  return String(t['OS-Surface'] ?? '').startsWith('mcp:') ? 'mcp' : 'ui';
}

/** The app-relative path of the file holding `id` among `paths` (repo-relative, under `prefix/`), or null. */
export function pathOfId(paths: string[], prefix: string, id: string): string | null {
  const isEpic = EPIC_ID_RE.test(id);
  const re = isEpic ? new RegExp(`^${STORIES_DIR}/${id}(?:-[a-z0-9-]+)?/_epic\\.md$`) : new RegExp(`^${STORIES_DIR}/EP-[0-9]+(?:-[a-z0-9-]+)?/${id}(?:-[a-z0-9-]+)?\\.md$`);
  for (const p of paths) {
    if (!p.startsWith(`${prefix}/`)) continue;
    const rel = `${STORIES_DIR}/${p.slice(prefix.length + 1)}`;
    if (re.test(rel)) return rel;
  }
  return null;
}

type Target = { domain: string; slug: string };

function storiesPrefix(t: Target): string {
  return `apps/${t.slug}/${STORIES_DIR}`;
}

/** Repo paths under the stories prefix at one commit, cached per sha. */
function treeReader(t: Target) {
  const cache = new Map<string, string[]>();
  const prefix = storiesPrefix(t);
  return async (sha: string): Promise<string[]> => {
    const hit = cache.get(sha);
    if (hit) return hit;
    const paths = (await listTree(t.domain, sha, { reposDir: config.reposDir })).map((e) => e.path).filter((p) => p.startsWith(`${prefix}/`));
    cache.set(sha, paths);
    return paths;
  };
}

/** The versions of one epic or story, newest first, of an app already resolved for the caller. */
export async function historyOf(t: Target, id: string): Promise<{ versions: SpecVersion[]; truncated: boolean }> {
  if (!STORY_ID_RE.test(id) && !EPIC_ID_RE.test(id)) throw Object.assign(new Error(`'${String(id).slice(0, 40)}' is not an epic or story id`), { status: 400 });
  const prefix = storiesPrefix(t);
  const { entries, truncated } = await logPath(t.domain, prefix, { reposDir: config.reposDir, limit: HISTORY_LIMIT * 2 });
  const tree = treeReader(t);
  const read = async (sha: string, rel: string | null): Promise<string | null> => {
    if (!rel) return null;
    return readBlob(t.domain, sha, `apps/${t.slug}/${rel}`, { reposDir: config.reposDir });
  };
  const versions: SpecVersion[] = [];
  for (const e of entries) {
    const after = pathOfId(await tree(e.sha), prefix, id);
    const parent = e.parents[0];
    const before = parent ? pathOfId(await tree(parent), prefix, id) : null;
    if (!after && !before) continue;
    const [a, b] = await Promise.all([read(parent ?? e.sha, before), read(e.sha, after)]);
    if (a === b) continue;
    const left = scrubSecrets(a ?? '').text;
    const right = scrubSecrets(b ?? '').text;
    const diff =
      unifiedDiff(left, right, { aLabel: before ?? after ?? id, bLabel: after ?? before ?? id }) ||
      `--- ${before ? `a/${before}` : '/dev/null'}\n+++ ${after ? `b/${after}` : '/dev/null'}\n@@ -0,0 +0,0 @@ the change is entirely inside redacted content\n`;
    const source = specSourceOf(e);
    const proposalId = source !== 'git' ? e.trailers['OS-Proposal'] : undefined;
    versions.push({
      sha: e.sha,
      at: new Date(e.timestamp * 1000).toISOString(),
      author: { id: (source !== 'git' && e.trailers['OS-Actor']) || e.author.email, name: e.author.name },
      source,
      ...(proposalId ? { proposalId } : {}),
      diff,
    });
    if (versions.length >= HISTORY_LIMIT) break;
  }
  return { versions, truncated: truncated || versions.length >= HISTORY_LIMIT };
}

/**
 * `specHistory(appId, user, id)` (plan, workstream A): the caller must be able to SEE the app; the app must be an App
 * Builder (template v2) app in a domain.
 */
export async function specHistory(appId: string, user: CurrentUser, id: string): Promise<SpecVersion[]> {
  assertAppBuilderEnabled();
  const { resolveSpecApp } = await import('@tabs/software/lib/stories/store');
  const app = await resolveSpecApp(appId, user, 'view');
  return (await historyOf({ domain: app.domain, slug: app.slug }, id)).versions;
}

/** Ids seen in the stories subtree's recent history (see the header). Best effort: an unreadable history is empty. */
export async function seenIdsInHistory(t: Target, storyId?: string): Promise<{ epics: string[]; stories: string[]; criteria: string[] }> {
  const epics = new Set<string>();
  const stories = new Set<string>();
  const criteria = new Set<string>();
  try {
    const prefix = storiesPrefix(t);
    const { entries } = await logPath(t.domain, prefix, { reposDir: config.reposDir, limit: SEEN_WINDOW });
    const tree = treeReader(t);
    for (const e of entries) {
      const paths = await tree(e.sha);
      const rel = paths.map((p) => `${STORIES_DIR}/${p.slice(prefix.length + 1)}`);
      const ids = idsInPaths(rel);
      ids.epics.forEach((x) => epics.add(x));
      ids.stories.forEach((x) => stories.add(x));
      if (storyId) {
        const at = pathOfId(paths, prefix, storyId);
        if (at) criterionIdsIn(await readBlob(t.domain, e.sha, `apps/${t.slug}/${at}`, { reposDir: config.reposDir })).forEach((x) => criteria.add(x));
      }
    }
  } catch (e) {
    console.warn(`[stories] the history of apps/${t.slug}/${STORIES_DIR} could not be read for id allocation: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { epics: [...epics], stories: [...stories], criteria: [...criteria] };
}
