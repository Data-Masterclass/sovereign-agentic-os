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
 *   - Validation (synchronous, refuses the push): the files the platform owns (PLATFORM_OWNED: gate files,
 *     Dockerfile, next.config.*, workflows, vendor, .npmrc) are neither editable nor removable by a push, otherwise an author could weaken the
 *     checks that judge the same push. `k8s/` is validated by the app-deploy kind (deploy-receive.ts).
 *   - STARTING THE CHECKS (trigger 1 of 3): after the registry is re-derived, a golden-path app gets one Tekton
 *     run for the pushed sha (tekton-checks.ts: idempotent per sha, a newer sha cancels the app's run in
 *     progress). The running record is stored on the app and the push output says so. A push is never
 *     rejected by a long job; a red result only blocks the deploy of that commit. When the engine cannot start
 *     the run, a FINISHED record carrying the reason is stored (never skipped silently, never green).
 */
import 'server-only';
import { APPS_DIR } from '@core/infra/repo-layout';
import { registerRepoKind, type ChangedFile, type IngestReport, type Pusher } from '@core/infra/git-receive';
import type { CurrentUser } from '@core/kernel/auth';
import { runWithSurface } from '@core/infra/request-surface';
import { getAppBySlugInternal, persistApp } from '@tabs/software/lib/apps';
import { APPS_PREFIX, readAppTreeState } from '@tabs/software/lib/git-commit';
import { appTreesIn, ingestFromRepo } from '@tabs/software/lib/ingest-from-repo';
import { gatePolicyFor } from '@tabs/software/lib/gate-policy';
import { withResult } from '@tabs/software/lib/check-record';
import { defaultChecksRunner, type ChecksRunner } from '@tabs/software/lib/tekton-checks';
import { watchChecks } from '@tabs/software/lib/checks-sync';
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

/** Removing a platform-owned file (the Dockerfile, a gate file, a next.config.*, k8s/) is refused like editing it. */
export function validateAppDelete(file: { path: string }): string | null {
  const s = split(file.path);
  if (s && isPlatformOwnedPath(s.inner)) {
    return `${file.path} is a platform-owned file (the platform owns how the app is built, deployed and gated). A push cannot remove it.`;
  }
  return null;
}

const asUser = (p: Pusher): CurrentUser => ({ id: p.id, name: p.name ?? p.id, domains: p.domains, allDomains: p.domains, activeDomain: null, role: p.role });

export type ReceiveDeps = { readTree?: (slug: string, sha: string, domain: string) => Promise<ScaffoldFile[]>; checks?: ChecksRunner };

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
      report.notes.push(`${APPS_DIR}/${slug}/ belongs to domain '${app.domain}', not '${input.domain}'; not ingested`);
      continue;
    }
    let tree: ScaffoldFile[] | null = null;
    try {
      tree = await readTree(slug, input.sha, input.domain);
      const full = tree.map((f) => ({ path: `${APPS_PREFIX}${slug}/${f.path}`, content: f.content }));
      const out = await runWithSurface('git:push', () => ingestFromRepo('app', full, user));
      for (const a of out.apps) {
        if (a.outcome === 'updated') {
          report.updated += 1;
          for (const issue of a.actionIssues ?? []) report.notes.push(`${APPS_DIR}/${slug}/actions.yml: ${issue.reason}`);
        } else {
          report.skipped += 1;
          report.notes.push(a.reason ?? `${APPS_DIR}/${slug}/ was not ingested`);
        }
      }
    } catch (e) {
      report.skipped += 1;
      report.notes.push(`${APPS_DIR}/${slug}/: the registry could not be re-derived (${e instanceof Error ? e.message : String(e)}); the files are stored`);
    }
    // Whether checks run is decided from the stored app (template + serve mode), never from a line in the pushed tree.
    if (tree && app && gatePolicyFor(app).required) await startChecks(slug, input, report, deps);
  }
  return report;
}

/** Trigger 1 of 3: one run for the pushed sha of an app that has a registry record and a stored app that requires the gates. */
async function startChecks(slug: string, input: { domain: string; sha: string }, report: IngestReport, deps: ReceiveDeps): Promise<void> {
  const app = await getAppBySlugInternal(slug);
  if (!app) return; // never create: a slug with no record is reported by the ingest, and has nothing to check
  try {
    const result = await (deps.checks ?? defaultChecksRunner)({ slug, domain: input.domain, sha: input.sha, trigger: 'push', waitMs: 0 });
    app.checks = withResult(app.checks, result);
    await persistApp(app);
    const r = result.record;
    if (r.error) report.notes.push(`${APPS_DIR}/${slug}/: the quality checks could not start for ${input.sha.slice(0, 12)}: ${r.error}`);
    else {
      report.notes.push(`${APPS_DIR}/${slug}/: quality checks started for ${input.sha.slice(0, 12)}${r.runRef ? ` (${r.runRef})` : ''}${result.superseded.length ? `; the run for ${result.superseded.map((x) => x.slice(0, 12)).join(', ')} was cancelled` : ''}`);
      if (r.status === 'running') watchChecks(slug, input.sha);
    }
  } catch (e) {
    report.notes.push(`${APPS_DIR}/${slug}/: the quality checks could not start (${e instanceof Error ? e.message : String(e)})`);
  }
}

export function registerAppIngest(): void {
  registerRepoKind({ kind: APP_KIND, matches: matchesApp, validate: validateAppFile, validateDelete: validateAppDelete, ingest: (i) => ingestApps(i) });
}
