/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder (C2) - legacy image apps on a registry that no longer exists: marked, never touched
 * USER STORY: As the owner I want apps whose images point at the removed registry to show "Needs rebuild" without anything
 *             in the cluster changing, and only an admin, explicitly, to scale their old Deployment down (and back up).
 * ARCHITECTURE: (spec 14)
 *   - `markNeedsRebuild` (the reconcile) runs ONLY with the switch on. It reads each image app's committed
 *     `k8s/deployment.yaml` from git and, when a container image names a registry other than the configured one,
 *     sets `deploy.state = 'needs-rebuild'` (and back to what the record says once it no longer does). It takes NO
 *     Kubernetes client at all: it cannot change the cluster, by construction (tested).
 *   - `runAppMigration` (MCP `run_app_migration`, admin only, explicit): scales the app's legacy `agentic-apps`
 *     Deployment (`app-<slug>`) to 0, or back to 1 with `undo`; recorded in the audit chain. Never automatic, never at
 *     boot. Only a marked app qualifies.
 *   - `deleteLegacyAfterProd`: after the FIRST successful Prod release of an app that still has legacy objects, the
 *     app's objects in `agentic-apps` are deleted (spec 14). Called by the go-live path only.
 */
import 'server-only';
import yaml from 'js-yaml';
import { appBuilderEnabled, assertAppBuilderEnabled } from '@core/kernel/app-builder-flag';
import type { CurrentUser } from '@core/kernel/auth';
import { config } from '@core/kernel/config';
import { record as recordAudit } from '@core/policy/audit';
import { roleAtLeast } from '@core/kernel/session';
import { templateVersionOf } from '@tabs/software/lib/app-builder-contracts';
import type { App } from '@tabs/software/lib/apps';
import { runnerName } from '@tabs/software/lib/native-deploy';
import { deleteApp as deleteLegacyRunner, scaleDeployment, type RunnerK8s } from '@tabs/software/lib/runner';

const withStatus = (e: Error, status: number) => Object.assign(e, { status });

/** Pure: why `files` (an app tree) points at a registry other than `registry`, or null. Only the image's host part counts. */
export function legacyRegistryReason(files: { path: string; content: string }[], registry: string): string | null {
  const dep = files.find((f) => f.path === 'k8s/deployment.yaml' || f.path === 'k8s/deployment.yml');
  if (!dep) return null;
  // A manifest that does not parse throws: the reconcile reports it and leaves the app as it is.
  const docs = yaml.loadAll(dep.content);
  const want = registry.replace(/\/+$/, '');
  for (const d of docs) {
    const pod = ((((d ?? {}) as Record<string, unknown>).spec as Record<string, unknown> | undefined)?.template as Record<string, unknown> | undefined)?.spec as Record<string, unknown> | undefined;
    for (const c of ((pod?.containers ?? []) as { image?: unknown }[])) {
      const image = String(c.image ?? '');
      if (!image) continue;
      const host = image.includes('/') ? image.split('/')[0] : '';
      if (!want) return `its image ${image} names a registry, and no platform registry is configured any more`;
      if (!image.startsWith(`${want}/`)) return `its image names the registry '${host || image}', not the platform registry '${want}'`;
    }
  }
  return null;
}

export type NeedsRebuildDeps = {
  apps: () => Promise<App[]>;
  readTree: (app: App) => Promise<{ kind: 'tree'; files: { path: string; content: string }[] } | { kind: 'none' } | { kind: 'failed'; reason: string }>;
  persist: (app: App) => Promise<unknown>;
  registry: string;
};

async function liveDeps(): Promise<NeedsRebuildDeps> {
  const apps = await import('@tabs/software/lib/apps');
  const { readAppTreeState } = await import('@tabs/software/lib/git-commit');
  return {
    apps: apps.listAllAppsInternal,
    readTree: async (app) => {
      const s = await readAppTreeState(app);
      return s.kind === 'tree' ? { kind: 'tree', files: s.files } : s.kind === 'failed' ? { kind: 'failed', reason: s.reason } : { kind: 'none' };
    },
    persist: apps.persistApp,
    registry: config.softwareImageRegistry,
  };
}

const stateAfterUnmark = (app: App): App['deploy']['state'] => (app.deploy.approvedSha ? 'live' : 'preview');

/** Mark (and unmark) legacy image apps. Writes only app records; returns the ids it marked and unmarked. */
export async function markNeedsRebuild(deps?: NeedsRebuildDeps): Promise<{ marked: string[]; unmarked: string[] }> {
  const out = { marked: [] as string[], unmarked: [] as string[] };
  if (!appBuilderEnabled()) return out;
  const d = deps ?? (await liveDeps());
  for (const app of await d.apps()) {
    if (app.serveMode !== 'image' || templateVersionOf(app) === 2 || app.status === 'archived') continue;
    const tree = await d.readTree(app);
    if (tree.kind !== 'tree') continue;
    let reason: string | null;
    try {
      reason = legacyRegistryReason(tree.files, d.registry);
    } catch (e) {
      console.error(`[os-ui] needs-rebuild: ${app.domain}/${app.slug} left as it is — its k8s/deployment.yaml does not parse (${e instanceof Error ? e.message.split('\n')[0] : String(e)})`);
      continue;
    }
    if (reason && app.deploy.state !== 'needs-rebuild') {
      app.deploy.state = 'needs-rebuild';
      await d.persist(app);
      out.marked.push(app.id);
    } else if (!reason && app.deploy.state === 'needs-rebuild') {
      app.deploy.state = stateAfterUnmark(app);
      await d.persist(app);
      out.unmarked.push(app.id);
    }
  }
  return out;
}

/** The reason a marked app shows (re-derived from git, never stored), or null. */
export async function needsRebuildReason(app: App, deps?: Pick<NeedsRebuildDeps, 'readTree' | 'registry'>): Promise<string | null> {
  if (app.deploy.state !== 'needs-rebuild') return null;
  const d = deps ?? (await liveDeps());
  const tree = await d.readTree(app);
  return tree.kind === 'tree' ? legacyRegistryReason(tree.files, d.registry) ?? 'its image is not on the platform registry' : 'its committed manifests could not be read';
}

export type MigrationResult = { appId: string; deployment: string; namespace: string; replicas: number; ok: boolean; detail: string };

/** Admin only, explicit: scale a marked app's legacy Deployment to 0 (or back to 1 with `undo`). Audited. */
export async function runAppMigration(app: App, user: CurrentUser, opts: { undo?: boolean; k8s?: RunnerK8s; namespace?: string } = {}): Promise<MigrationResult> {
  assertAppBuilderEnabled();
  if (!roleAtLeast(user.role, 'admin') || user.via) throw withStatus(new Error('only an administrator can run the app migration'), 403);
  if (app.deploy.state !== 'needs-rebuild') throw withStatus(new Error(`'${app.name}' is not marked "needs rebuild"; there is nothing to migrate`), 409);
  const namespace = opts.namespace ?? config.softwareRunnerNamespace;
  const deployment = runnerName(app.slug);
  const replicas = opts.undo ? 1 : 0;
  const r = await scaleDeployment(namespace, deployment, replicas, opts.k8s);
  recordAudit({
    actor: user.id,
    action: 'deploy',
    subject: app.id,
    domain: app.domain,
    reason: `app migration${opts.undo ? ' undone' : ''}: ${namespace}/${deployment} scaled to ${replicas} (${r.detail})`,
    detail: { kind: 'app.migration', undo: !!opts.undo, namespace, deployment, replicas, ok: r.ok },
  });
  if (!r.ok && r.phase !== 'absent') throw withStatus(new Error(r.detail), r.phase === 'offline' ? 503 : 502);
  return { appId: app.id, deployment, namespace, replicas, ok: r.ok, detail: r.detail };
}

/** After the first successful Prod release: remove the app's legacy objects from `agentic-apps` (spec 14). */
export async function deleteLegacyAfterProd(app: App, actor: { id: string }, opts: { k8s?: RunnerK8s; namespace?: string } = {}): Promise<boolean> {
  if (app.deploy.state !== 'needs-rebuild') return false;
  const out = await deleteLegacyRunner({ slug: app.slug }, { k8s: opts.k8s, namespace: opts.namespace ?? config.softwareRunnerNamespace });
  recordAudit({ actor: actor.id, action: 'deploy', subject: app.id, domain: app.domain, reason: `legacy objects of ${app.slug} in ${opts.namespace ?? config.softwareRunnerNamespace} removed after the first Prod release: ${out.detail}`, detail: { kind: 'app.migration.cleanup', ok: out.ok } });
  return out.ok;
}
