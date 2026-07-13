/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/core/auth';
import {
  getAppByIdInternal,
  persistApp,
  listAllAppsInternal,
  removeAppInternal,
  deleteAppRepo,
  withStatus,
  type App,
} from '@/lib/software/apps';
import { removeConnection, setConnectionVisibility } from '@/lib/infra/app-registry';
import { unregisterConnectionProfile, trace } from '@/lib/infra/agent-governed';
import { generateAndCompile } from './auto-mcp.ts';
import { stopApp as stopRunner, deleteApp as deleteRunner } from './runner.ts';
import type { ConsumedResource } from './model.ts';
import { roleAtLeast } from '@/lib/core/session';
import { canManageArtifact } from '@/lib/governance/edit-scope';
import type { Visibility } from '@/lib/core/artifact-model';
import { getArtifact, demoteArtifact } from '@/lib/core/artifacts';

/**
 * App lifecycle + resource consumption (Software golden path §F).
 *
 *   • ARCHIVE disables the app + its MCP/connection but RETAINS data (restorable).
 *   • DELETE is governed + LINEAGE-AWARE — it cannot orphan a dependency that is
 *     in use (a shared connection / a data product another app relies on).
 *   • "USE AS DATA" snapshots the app's operational data into a Bronze dataset.
 *   • CONSUME a granted Connection/Data/Knowledge/other-app MCP — OPA-scoped,
 *     NEVER embedding raw credentials (the reference is recorded, not a secret).
 *
 * The lineage check is the security-relevant part: it mirrors the OpenMetadata
 * lineage gate ("blocked while a dependency is in use") with an in-process
 * consumer scan so it is demonstrable offline.
 */

function isOwnerOrAdmin(app: App, user: CurrentUser): boolean {
  // Fail-closed edit-scope: owner, domain_admin of the owning domain, or admin.
  return canManageArtifact(user, { owner: app.owner, domain: app.domain });
}

// --------------------------------------------------------------- Archive -------

/** Archive: scale to zero + disable the MCP/connection; retain data (restorable). */
export async function archiveApp(appId: string, user: CurrentUser): Promise<App> {
  const app = await getAppByIdInternal(appId);
  if (!app) throw withStatus(new Error('App not found'), 404);
  if (!isOwnerOrAdmin(app, user)) throw withStatus(new Error('Only the owner or an Admin can archive this app'), 403);
  if (app.status === 'archived') return app;

  app.status = 'archived';
  app.deploy.state = 'building'; // scaled to zero, no longer live/preview
  app.deploy.previewUrl = null;
  app.pipeline.live = 'disabled';
  // Scale the in-cluster runner to zero (retains the objects so unarchive can
  // re-provision). Best-effort + honestly reported; a stopped/absent/offline
  // runner never blocks the archive.
  const stopped = await stopRunner({ slug: app.slug });
  // Disable the MCP: drop the app-registry grant + the compiled OPA profile so
  // no agent can call its tools while archived. Data artifacts are RETAINED.
  removeConnection(app.id);
  unregisterConnectionProfile(app.mcpPrincipal);
  await persistApp(app);
  void trace({
    principal: app.mcpPrincipal,
    tool: 'generate',
    input: { action: 'archive_app', by: user.id },
    output: { status: 'archived', dataRetained: app.dataArtifactId, runner: stopped.action, runnerLive: stopped.live },
    decision: 'allow',
  });
  return app;
}

/** Restore an archived app: re-arm its MCP grant + OPA profile, back to preview. */
export async function unarchiveApp(appId: string, user: CurrentUser): Promise<App> {
  const app = await getAppByIdInternal(appId);
  if (!app) throw withStatus(new Error('App not found'), 404);
  if (!isOwnerOrAdmin(app, user)) throw withStatus(new Error('Only the owner or an Admin can restore this app'), 403);
  if (app.status === 'active') return app;
  app.status = 'active';
  app.deploy.state = 'preview';
  app.pipeline.live = 'pending';
  generateAndCompile(app.mcpPrincipal, { tools: app.mcpTools });
  await persistApp(app);
  void trace({
    principal: app.mcpPrincipal,
    tool: 'generate',
    input: { action: 'unarchive_app', by: user.id },
    output: { status: 'active' },
    decision: 'allow',
  });
  return app;
}

// ----------------------------------------------------------- Lineage / delete --

export type DependencyUse = { by: string; kind: ConsumedResource['kind']; ref: string };

/**
 * Find apps that DEPEND ON the given app — i.e. consume its MCP, its connection,
 * or its data product. Used to block a delete that would orphan them. Pure read.
 */
export async function dependentsOf(app: App): Promise<DependencyUse[]> {
  const all = await listAllAppsInternal();
  const refs = new Set<string>(
    [app.mcpPrincipal, app.connectionId, app.dataArtifactId, app.slug].filter(Boolean) as string[],
  );
  const out: DependencyUse[] = [];
  for (const other of all) {
    if (other.id === app.id) continue;
    for (const c of other.consumes) {
      if (refs.has(c.ref)) out.push({ by: other.id, kind: c.kind, ref: c.ref });
    }
  }
  return out;
}

/**
 * Delete the app — BLOCKED while a dependency is in use (lineage-aware). On a
 * clean delete, removes the app + its MCP grant/profile. Data products are left
 * to their own lifecycle (the artifact ladder) unless the caller also removes
 * them; we never silently orphan a consumed product.
 */
export async function deleteApp(appId: string, user: CurrentUser): Promise<{ deleted: true }> {
  const app = await getAppByIdInternal(appId);
  if (!app) throw withStatus(new Error('App not found'), 404);
  if (!isOwnerOrAdmin(app, user)) throw withStatus(new Error('Only the owner or an Admin can delete this app'), 403);

  const deps = await dependentsOf(app);
  if (deps.length > 0) {
    const names = deps.map((d) => `${d.by} (${d.kind})`).join(', ');
    throw withStatus(
      new Error(`Delete blocked — this app is a dependency in use by: ${names}. Remove those uses first.`),
      409,
    );
  }
  // PHYSICALLY tear down the app's live resources before removing the record so a
  // delete never orphans running pods or a live repo. Both are best-effort + HONEST:
  //   • the in-cluster runner (Ingress+Service+Deployment) — 404/offline is benign;
  //   • the per-app Forgejo repo (created at build) — 404/unreachable is reported,
  //     never a silent "repo gone".
  const teardown = await deleteRunner({ slug: app.slug });
  const repo = await deleteAppRepo(app);
  removeConnection(app.id);
  unregisterConnectionProfile(app.mcpPrincipal);
  await removeAppInternal(app.id);
  void trace({
    principal: app.mcpPrincipal,
    tool: 'generate',
    input: { action: 'delete_app', by: user.id },
    output: {
      deleted: app.id,
      runner: teardown.action,
      runnerLive: teardown.live,
      repo: repo.action,
      repoOk: repo.ok,
    },
    decision: 'allow',
  });
  return { deleted: true };
}

/**
 * Demotion (revoke sharing): the reverse of `promoteApp`, one step down —
 * Certified → Shared (admin only) → Personal (owner or in-domain builder/admin).
 * LINEAGE-AWARE (mirrors deleteApp): blocked while another app depends on this
 * app's MCP/connection/data — we never orphan a live consumer. Never deletes the
 * app; only lowers its (and its files'/connection's/data artifact's) visibility.
 */
export async function demoteApp(appId: string, user: CurrentUser): Promise<App> {
  const app = await getAppByIdInternal(appId);
  if (!app) throw withStatus(new Error('App not found'), 404);
  if (!user.domains.includes(app.domain)) {
    throw withStatus(new Error('You can only revoke sharing on apps in a domain you belong to'), 403);
  }

  let next: Visibility;
  if (app.visibility === 'Certified') {
    if (user.role !== 'admin') throw withStatus(new Error('Revoking from the Marketplace requires an Administrator'), 403);
    next = 'Shared';
  } else if (app.visibility === 'Shared') {
    if (!canManageArtifact(user, { owner: app.owner, domain: app.domain })) {
      throw withStatus(new Error('Unsharing requires the owner, an in-domain Domain admin, or an Administrator'), 403);
    }
    next = 'Personal';
  } else {
    throw withStatus(new Error('Already Personal — nothing to revoke'), 400);
  }

  // Lineage guard: an app other consumers rely on cannot be pulled out from under
  // them (same discipline as delete).
  const deps = await dependentsOf(app);
  if (deps.length > 0) {
    const names = deps.map((d) => `${d.by} (${d.kind})`).join(', ');
    throw withStatus(
      new Error(`Revoke blocked — this app is a dependency in use by: ${names}. Remove those uses first.`),
      409,
    );
  }

  app.visibility = next;
  app.files = app.files.map((f) => ({ ...f, visibility: next }));
  setConnectionVisibility(app.id, next);
  // Cascade the data artifact down the SAME ladder (best-effort; it may be pinned
  // by its own consumers, in which case its demote throws and we leave it shared).
  if (app.dataArtifactId) {
    try {
      const art = await getArtifact(app.dataArtifactId);
      if (art && art.visibility !== 'Personal') await demoteArtifact(app.dataArtifactId, user);
    } catch {
      /* artifact pinned or already lower — leave it */
    }
  }
  await persistApp(app);
  void trace({
    principal: app.mcpPrincipal,
    tool: 'generate',
    input: { action: 'demote_app', by: user.id, role: user.role },
    output: { appId: app.id, visibility: next },
    decision: 'allow',
  });
  return app;
}

// ------------------------------------------------------------- Use as Data -----

/**
 * "Use as Data" — the app's operational data stays in Supabase; this snapshots it
 * into a (personal) Bronze dataset (dlt → Bronze). The data artifact was created
 * with the app; this marks the explicit snapshot the creator asked for so it
 * flows into the Data golden path.
 */
export async function useAsData(appId: string, user: CurrentUser): Promise<App> {
  const app = await getAppByIdInternal(appId);
  if (!app) throw withStatus(new Error('App not found'), 404);
  if (app.owner !== user.id) throw withStatus(new Error('Only the owner can snapshot this app as Data'), 403);
  app.usedAsData = true;
  await persistApp(app);
  void trace({
    principal: app.mcpPrincipal,
    tool: 'generate',
    input: { action: 'use_as_data', by: user.id },
    output: { dataset: app.dataArtifactId, layer: 'bronze' },
    decision: 'allow',
  });
  return app;
}

// ----------------------------------------------------- Consume a resource ------

/**
 * The app CONSUMES a granted platform resource (a Connection / Data product /
 * Knowledge / another app's MCP) — OPA-scoped, NO raw creds (external creds via
 * the Connection; app secrets via External Secrets). Recording a consumed
 * connection broadens the app's declared scope, so the NEXT domain deploy
 * re-opens the Builder review gate (`scopeBroadened`).
 */
export async function consumeResource(
  appId: string,
  user: CurrentUser,
  resource: ConsumedResource,
): Promise<App> {
  const app = await getAppByIdInternal(appId);
  if (!app) throw withStatus(new Error('App not found'), 404);
  if (app.owner !== user.id && !roleAtLeast(user.role, 'builder')) {
    throw withStatus(new Error('Only the owner or a Builder can grant the app a resource'), 403);
  }
  // Never accept an inline secret — only a reference.
  if (!resource.ref || /password|secret|token|key=/i.test(resource.ref)) {
    throw withStatus(new Error('A consumed resource is a reference, never a raw credential'), 400);
  }
  if (!app.consumes.some((c) => c.kind === resource.kind && c.ref === resource.ref)) {
    app.consumes.push({
      kind: resource.kind,
      ref: resource.ref,
      label: resource.label,
      scope: resource.scope === 'write-bounded' ? 'write-bounded' : 'read',
    });
    if (resource.kind === 'connection') {
      app.manifest = { ...app.manifest, connections: [...new Set([...app.manifest.connections, resource.ref])] };
    }
  }
  await persistApp(app);
  void trace({
    principal: app.mcpPrincipal,
    tool: 'generate',
    input: { action: 'consume_resource', by: user.id, kind: resource.kind, ref: resource.ref },
    output: { consumes: app.consumes.length, noRawCreds: true },
    decision: 'allow',
  });
  return app;
}
