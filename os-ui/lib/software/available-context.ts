/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { listDatasets, ensureHydrated as ensureDataHydrated } from '@/lib/data/store';
import { listWorkflows, ensureHydrated as ensureWorkflowsHydrated } from '@/lib/knowledge/store';
import { listPersonalKnowledge, ensureHydrated as ensurePersonalHydrated } from '@/lib/knowledge/personal-store';
import { listMetrics } from '@/lib/metrics/store';
import { listConnectionsForUser } from '@/lib/connections';
import { listFiles, ensureHydrated as ensureFilesHydrated } from '@/lib/files/store';
import { listFolders } from '@/lib/folders/index';
import type { ContextKind } from '@/lib/core/context-grants';
import type { CurrentUser } from '@/lib/core/auth';

/**
 * The SERVER-SIDE grantable-context feed — the SAME canView/RLS-scoped lists the
 * `/api/context/available` route serves the ContextGrants picker, lifted so the
 * governed Software assistant route can read them directly (without a self-fetch) and
 * ground its Define-stage grant suggestions in REAL, DLS-scoped ids. One source of
 * truth for "what may this caller grant".
 */

export type AvailableScope = 'personal' | 'domain' | 'marketplace';
export type AvailableContextItem = {
  id: string;
  name: string;
  scope: AvailableScope;
  /** The folder path this item lives in (foldered kinds only; `'/'` = root). */
  folder?: string;
};
export type AvailableContext = Partial<Record<ContextKind, AvailableContextItem[]>>;

/** A folder row a foldered kind exposes, split by root, for the FolderTree grant view. */
export type AvailableFolder = { path: string; scope: 'personal' | 'domain' };
export type AvailableContextFolders = Partial<Record<ContextKind, AvailableFolder[]>>;

/** The kinds that live in folders (and so support folder-level grant selection). */
const FOLDERED_KINDS: ContextKind[] = ['data', 'knowledge', 'files'];
/** Map a foldered context kind to its folder-registry tab. */
const KIND_TAB: Record<'data' | 'knowledge' | 'files', 'data' | 'knowledge' | 'files'> = {
  data: 'data',
  knowledge: 'knowledge',
  files: 'files',
};

/** The grantable artifacts of ONE kind the caller can see (personal + domain + marketplace). */
async function forKind(kind: ContextKind, user: CurrentUser): Promise<AvailableContextItem[]> {
  const principal = { id: user.id, domains: user.domains, role: user.role };
  if (kind === 'data') {
    await ensureDataHydrated();
    const g = listDatasets(principal);
    return [
      ...g.mine.map((d) => ({ id: d.id, name: d.name, scope: 'personal' as const, folder: d.folder ?? '/' })),
      ...g.domain.map((d) => ({ id: d.id, name: d.name, scope: 'domain' as const, folder: d.folder ?? '/' })),
      ...g.marketplace.map((d) => ({ id: d.id, name: d.name, scope: 'marketplace' as const })),
    ];
  }
  if (kind === 'knowledge') {
    await Promise.all([ensureWorkflowsHydrated(), ensurePersonalHydrated()]);
    const wf = listWorkflows(principal);
    const pk = listPersonalKnowledge(principal);
    return [
      // Workflows carry no folder registry — they show at root.
      ...wf.mine.map((w) => ({ id: w.id, name: w.title, scope: 'personal' as const, folder: '/' })),
      ...wf.domain.map((w) => ({ id: w.id, name: w.title, scope: 'domain' as const, folder: '/' })),
      ...wf.marketplace.map((w) => ({ id: w.id, name: w.title, scope: 'marketplace' as const })),
      ...pk.mine.map((p) => ({ id: p.id, name: p.title, scope: 'personal' as const, folder: p.folder ?? '/' })),
      ...pk.domain.map((p) => ({ id: p.id, name: p.title, scope: 'domain' as const, folder: p.folder ?? '/' })),
      ...pk.marketplace.map((p) => ({ id: p.id, name: p.title, scope: 'marketplace' as const })),
    ];
  }
  if (kind === 'files') {
    await ensureFilesHydrated();
    const g = listFiles(principal);
    return [
      ...g.mine.map((f) => ({ id: f.id, name: f.name, scope: 'personal' as const, folder: f.folder ?? '/' })),
      ...g.domain.map((f) => ({ id: f.id, name: f.name, scope: 'domain' as const, folder: f.folder ?? '/' })),
      ...g.marketplace.map((f) => ({ id: f.id, name: f.name, scope: 'marketplace' as const })),
    ];
  }
  if (kind === 'metrics') {
    await ensureDataHydrated();
    const g = listMetrics(principal);
    const nm = (m: { datasetName: string; name: string }) => `${m.datasetName} · ${m.name}`;
    return [
      ...g.mine.map((m) => ({ id: m.id, name: nm(m), scope: 'personal' as const })),
      ...g.domain.map((m) => ({ id: m.id, name: nm(m), scope: 'domain' as const })),
      ...g.marketplace.map((m) => ({ id: m.id, name: nm(m), scope: 'marketplace' as const })),
    ];
  }
  // connections — the async, already canView-scoped list.
  const conns = await listConnectionsForUser(user);
  return conns.map((c) => ({
    id: c.id,
    name: c.name,
    scope: c.visibility === 'Certified' ? 'marketplace' : c.visibility === 'Shared' ? 'domain' : 'personal',
  }));
}

/** The folder rows (personal + domain) a foldered kind exposes to the grant tree. */
function foldersForKind(kind: ContextKind, user: CurrentUser): AvailableFolder[] {
  if (!FOLDERED_KINDS.includes(kind)) return [];
  const tab = KIND_TAB[kind as 'data' | 'knowledge' | 'files'];
  const principal = { id: user.id, domains: user.domains, role: user.role };
  try {
    const personal = listFolders(principal, tab, 'personal').map((f) => ({ path: f.path, scope: 'personal' as const }));
    const domain = listFolders(principal, tab, 'domain').map((f) => ({ path: f.path, scope: 'domain' as const }));
    return [...personal, ...domain];
  } catch {
    return [];
  }
}

/** The grantable context of the requested kinds the caller can see. Best-effort per kind. */
export async function availableContext(user: CurrentUser, kinds: ContextKind[]): Promise<AvailableContext> {
  const out: AvailableContext = {};
  await Promise.all(
    kinds.map(async (kind) => {
      try {
        out[kind] = await forKind(kind, user);
      } catch {
        out[kind] = [];
      }
    }),
  );
  return out;
}

/**
 * The grantable context of the requested kinds PLUS the folder rows for foldered kinds,
 * so the Define stage can offer folder-OR-item grant selection via the shared FolderTree.
 */
export async function availableContextWithFolders(
  user: CurrentUser,
  kinds: ContextKind[],
): Promise<{ items: AvailableContext; folders: AvailableContextFolders }> {
  const items = await availableContext(user, kinds);
  const folders: AvailableContextFolders = {};
  for (const kind of kinds) {
    if (FOLDERED_KINDS.includes(kind)) folders[kind] = foldersForKind(kind, user);
  }
  return { items, folders };
}
