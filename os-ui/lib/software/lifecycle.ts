/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/auth';
import {
  getAppByIdInternal,
  persistApp,
  listAllAppsInternal,
  removeAppInternal,
  withStatus,
  type App,
} from '@/lib/apps';
import { removeConnection } from '@/lib/app-registry';
import { unregisterConnectionProfile, trace } from '@/lib/agent-governed';
import { generateAndCompile } from './auto-mcp.ts';
import type { ConsumedResource } from './model.ts';

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
  return app.owner === user.id || (user.role === 'admin' && user.domains.includes(app.domain));
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
  // Disable the MCP: drop the app-registry grant + the compiled OPA profile so
  // no agent can call its tools while archived. Data artifacts are RETAINED.
  removeConnection(app.id);
  unregisterConnectionProfile(app.mcpPrincipal);
  await persistApp(app);
  void trace({
    principal: app.mcpPrincipal,
    tool: 'generate',
    input: { action: 'archive_app', by: user.id },
    output: { status: 'archived', dataRetained: app.dataArtifactId },
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
  removeConnection(app.id);
  unregisterConnectionProfile(app.mcpPrincipal);
  await removeAppInternal(app.id);
  void trace({
    principal: app.mcpPrincipal,
    tool: 'generate',
    input: { action: 'delete_app', by: user.id },
    output: { deleted: app.id },
    decision: 'allow',
  });
  return { deleted: true };
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
  if (app.owner !== user.id && user.role !== 'builder' && user.role !== 'admin') {
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
