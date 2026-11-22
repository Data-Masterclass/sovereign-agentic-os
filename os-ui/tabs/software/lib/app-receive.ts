/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    A `git push` to `apps/<slug>/` re-derives the app registry (Software Factory go-live 1)
 * USER STORY: As an engineer who opens an app in VS Code and pushes, I want the OS to pick the change
 *             up the way it does for a UI or MCP edit, and I never want a push to widen who sees an
 *             app, promote it or delete it.
 * ARCHITECTURE:
 *   - The join between the receive gate's `registerRepoKind` seam (core/infra/git-receive) and
 *     `ingestFromRepo('app', files)` (ingest-from-repo.ts). Nothing is parsed or decided here.
 *   - The gate hands a post-receive CHANGED set; the registry cache must follow the WHOLE tree, so the
 *     full `apps/<slug>/` tree at the pushed sha is read back and that is what is ingested.
 *   - The two contract rules every kind obeys: NEVER APPLY AUDIENCE (domain, status, owner and
 *     visibility are not read from files: `rederive` touches manifest, surface, auto-MCP and declared
 *     actions only) and NEVER RETIRE (a removed file is reported). A slug with no record is
 *     `unmatched`; an app of another domain than the repo is skipped.
 *   - Validation (synchronous, refuses the push): the gate files the platform owns (`policy/`,
 *     `scripts/factory-gates.mjs`) are not editable by a push, otherwise an author could weaken the
 *     checks that judge the same push. `k8s/` is validated by the app-deploy kind (deploy-receive.ts).
 *   - Starting the checks for the pushed sha is NOT done here (the engine that runs them is decided
 *     separately); the report says so instead of implying they ran.
 */
import 'server-only';
import { registerRepoKind, type ChangedFile, type IngestReport, type Pusher } from '@core/infra/git-receive';
import type { CurrentUser } from '@core/kernel/auth';
import { runWithSurface } from '@core/infra/request-surface';
import { getAppBySlugInternal } from '@tabs/software/lib/apps';
import { APPS_PREFIX, readAppTreeState } from '@tabs/software/lib/git-commit';
import { appTreesIn, ingestFromRepo } from '@tabs/software/lib/ingest-from-repo';
import type { ScaffoldFile } from '@tabs/software/lib/model';
import { isPlatformOwnedPath } from '@tabs/software/lib/golden-path';

export const APP_KIND = 'app';

/**
 * Paths inside an app a push may not change: the whole PLATFORM_OWNED list (golden-path.ts), the same rule the
 * MCP push and the UI editor enforce. `k8s/` is the one exception here: the app-deploy kind (deploy-receive.ts)
 * validates it against the deploy gate.
 */
const isGateOwned = (inner: string): boolean => isPlatformOwnedPath(inner) && !inner.startsWith('k8s/');

function split(path: string): { slug: string; inner: string } | null {
  if (!path.startsWith(APPS_PREFIX)) return null;
  const rest = path.slice(APPS_PREFIX.length);
  const i = rest.indexOf('/');
  if (i <= 0 || i === rest.length - 1) return null;
  return { slug: rest.slice(0, i), inner: rest.slice(i + 1) };
}

export const matchesApp = (path: string): boolean => split(path) !== null;

export function validateAppFile(file: { path: string; content: string }): string | null {
  const s = split(file.path);
  if (s && isGateOwned(s.inner)) {
    return `${file.path} is a platform-owned file (the platform owns how the app is built, deployed and gated). A push cannot change it; the platform updates it with the template.`;
  }
  return null;
}

const asUser = (p: Pusher): CurrentUser => ({ id: p.id, name: p.name ?? p.id, domains: p.domains, allDomains: p.domains, activeDomain: null, role: p.role });

export type ReceiveDeps = { readTree?: (slug: string, sha: string, domain: string) => Promise<ScaffoldFile[]> };

async function defaultReadTree(slug: string, sha: string, domain: string): Promise<ScaffoldFile[]> {
  const state = await readAppTreeState({ slug, domain }, { ref: sha });
  if (state.kind !== 'tree') throw new Error(state.kind === 'failed' ? state.reason : 'the repository returned no tree');
  return state.files;
}

export async function ingestApps(input: { domain: string; files: ChangedFile[]; pusher: Pusher; sha: string }, deps: ReceiveDeps = {}): Promise<IngestReport> {
  const report: IngestReport = { kind: APP_KIND, created: 0, updated: 0, skipped: 0, notes: [] };
  const readTree = deps.readTree ?? defaultReadTree;
  const slugs = new Set<string>();
  for (const f of input.files) {
    const s = split(f.path);
    if (!s) continue;
    if (f.status === 'deleted' || f.content === null) report.notes.push(`${f.path} was removed from the repo; retire the app in the OS to remove it (a push never retires)`);
    else slugs.add(s.slug);
  }
  const user = asUser(input.pusher);
  for (const slug of slugs) {
    const app = await getAppBySlugInternal(slug);
    if (app && app.domain && app.domain !== input.domain) {
      report.skipped += 1;
      report.notes.push(`apps/${slug}/ belongs to domain '${app.domain}', not '${input.domain}'; not ingested`);
      continue;
    }
    try {
      const tree = await readTree(slug, input.sha, input.domain);
      const full = tree.map((f) => ({ path: `${APPS_PREFIX}${slug}/${f.path}`, content: f.content }));
      const out = await runWithSurface('git:push', () => ingestFromRepo('app', full, user));
      for (const a of out.apps) {
        if (a.outcome === 'updated') {
          report.updated += 1;
          for (const issue of a.actionIssues ?? []) report.notes.push(`apps/${slug}/actions.yml: ${issue.reason}`);
        } else {
          report.skipped += 1;
          report.notes.push(a.reason ?? `apps/${slug}/ was not ingested`);
        }
      }
    } catch (e) {
      report.skipped += 1;
      report.notes.push(`apps/${slug}/: the registry could not be re-derived (${e instanceof Error ? e.message : String(e)}); the files are stored`);
    }
  }
  if (slugs.size > 0) report.notes.push('quality checks are not started by a push yet; run them with verify_app_gates');
  return report;
}

export function registerAppIngest(): void {
  registerRepoKind({ kind: APP_KIND, matches: matchesApp, validate: validateAppFile, ingest: (i) => ingestApps(i) });
}
