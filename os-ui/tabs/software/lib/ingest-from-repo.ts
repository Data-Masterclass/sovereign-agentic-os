/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    `ingestFromRepo('app', files)` — the registry re-derived FROM the pushed files
 * USER STORY: As an engineer who edits an app from VS Code and pushes, I want the OS registry to
 *             pick it up exactly as if I had used the UI or the MCP: the same tree, the same
 *             parsed manifest, the same auto-MCP tools, the same declared actions — the coin test
 *             (night-2, decision D29; stream E owns the orchestration, this is S's ingest).
 * ARCHITECTURE:
 *   - A FILE IS AUTHORITATIVE; A REGISTRY ROW IS A CACHE OF IT. This runs the half of
 *     `commitToApp` that happens AFTER the write — re-parse the manifest over the whole tree,
 *     re-resolve the surface, recompile the auto-MCP from the committed OpenAPI, re-read the
 *     declared actions, refresh the read cache — and nothing else. It does NOT commit: the push
 *     already did, and re-committing would be a loop.
 *   - IT NEVER CREATES AN APP. A pushed `apps/<slug>/` with no app record is reported as
 *     `unmatched`, not conjured into existence: `createApp` carries the coded-apps gate, the role
 *     gate, the domain assignment and the principal registration, and a push must not bypass any
 *     of them. The honest answer is "this tree has no app record — create the app, then push".
 *   - The caller (E's `reconcileFromGit`) owns attribution: the registry write is attributed to
 *     THE PUSHER with `OS-Surface: git:push`. This function takes the acting user and does not
 *     invent one.
 *   - Pure where it can be: `appTreesIn` is a plain function over the file list and is the part
 *     the coin test drives directly.
 */
import 'server-only';
import type { CurrentUser } from '@core/kernel/auth';
import { getAppBySlugInternal, persistApp, type App } from '@tabs/software/lib/apps';
import { snapshotFiles } from '@tabs/software/lib/file-mirror';
import { parseAppManifest, parseOpenApi, resolveSurface, reconcileKnowledgeConsumes } from '@tabs/software/lib/metadata';
import { generateAndCompile } from '@tabs/software/lib/auto-mcp';
import { parseAppActions, type ActionParseIssue } from '@tabs/software/lib/app-actions';
import { APPS_PREFIX } from '@tabs/software/lib/git-commit';
import type { ScaffoldFile } from '@tabs/software/lib/model';

/** The object kinds this module ingests. One today; the signature is E's shared one. */
export type IngestKind = 'app';

export type IngestedApp = {
  slug: string;
  appId: string | null;
  /** 'updated' — the registry was re-derived; 'unmatched' — no app record owns this tree. */
  outcome: 'updated' | 'unmatched';
  files: number;
  reason?: string;
  actionIssues?: ActionParseIssue[];
};

export type IngestResult = { kind: IngestKind; apps: IngestedApp[] };

/**
 * Group a pushed file list into `slug → files`, with the `apps/<slug>/` prefix stripped so the
 * paths are exactly what the app's own tree uses. Files outside `apps/` are ignored (another
 * kind's ingest owns them). Pure.
 */
export function appTreesIn(files: { path: string; content: string }[]): Map<string, ScaffoldFile[]> {
  const out = new Map<string, ScaffoldFile[]>();
  for (const f of files) {
    const p = String(f?.path ?? '');
    if (!p.startsWith(APPS_PREFIX)) continue;
    const rest = p.slice(APPS_PREFIX.length);
    const slash = rest.indexOf('/');
    if (slash <= 0) continue; // `apps/foo` with no file under it is not a tree
    const slug = rest.slice(0, slash);
    const inner = rest.slice(slash + 1);
    if (!inner) continue;
    const list = out.get(slug) ?? [];
    list.push({ path: inner, content: String(f.content ?? '') });
    out.set(slug, list);
  }
  return out;
}

/** The post-write half of `commitToApp`, applied to a tree that arrived by push. */
async function rederive(app: App, tree: ScaffoldFile[]): Promise<ActionParseIssue[]> {
  const manifest = parseAppManifest(tree, { name: app.name, owner: app.owner, description: app.description });
  app.manifest = manifest;
  if (manifest.declaredSurface) app.declaredSurface = manifest.declaredSurface;
  app.consumes = reconcileKnowledgeConsumes(app.consumes, manifest.knowledge);
  app.surface = resolveSurface(tree, app.declaredSurface);
  const openapi = parseOpenApi(tree);
  if (openapi) {
    const tools = generateAndCompile(app.mcpPrincipal, { openapi });
    app.mcpTools = tools.map((t) => ({ name: t.name, description: t.description, write: t.write }));
    app.mcpProfileCompiled = true;
  }
  const { issues } = parseAppActions(tree);
  // The read cache follows the files (git is the home of record).
  snapshotFiles(app.id, tree);
  await persistApp(app);
  return issues;
}

/**
 * Re-derive the app registry from the files a push landed. `files` are repo-relative paths at the
 * new head (E passes the changed set, or the whole `apps/` subtree — either works, because the
 * ingest is idempotent over a whole tree).
 */
export async function ingestFromRepo(
  kind: IngestKind,
  files: { path: string; content: string }[],
  user: CurrentUser,
): Promise<IngestResult> {
  if (kind !== 'app') return { kind, apps: [] };
  const trees = appTreesIn(files);
  const apps: IngestedApp[] = [];
  for (const [slug, tree] of trees) {
    const app = await getAppBySlugInternal(slug);
    if (!app) {
      apps.push({
        slug,
        appId: null,
        outcome: 'unmatched',
        files: tree.length,
        reason:
          `No app record owns 'apps/${slug}/'. A push does not create an app: creating one carries the ` +
          'coded-apps gate, the role gate, the domain assignment and the MCP principal registration. ' +
          'Create the app (create_software), then push to it.',
      });
      continue;
    }
    // Visibility is the PUSHER's: a push that touches an app the pusher cannot see is not ingested.
    const sameDomain = !app.domain || user.domains.includes(app.domain);
    if (!sameDomain) {
      apps.push({ slug, appId: null, outcome: 'unmatched', files: tree.length, reason: `'apps/${slug}/' belongs to a domain you are not in.` });
      continue;
    }
    const actionIssues = await rederive(app, tree);
    apps.push({ slug, appId: app.id, outcome: 'updated', files: tree.length, actionIssues });
  }
  return { kind, apps };
}
