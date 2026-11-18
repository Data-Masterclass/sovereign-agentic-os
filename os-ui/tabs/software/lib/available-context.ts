/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { listDatasets, ensureHydrated as ensureDataHydrated } from '@tabs/data/lib/store';
import { listWorkflows, ensureHydrated as ensureWorkflowsHydrated } from '@tabs/knowledge/lib/store';
import { listPersonalKnowledge, ensureHydrated as ensurePersonalHydrated } from '@tabs/knowledge/lib/personal-store';
import { listMetrics } from '@tabs/metrics/lib/store';
import { listConnectionsForUser } from '@tabs/connections/lib/index';
import { listFiles, ensureHydrated as ensureFilesHydrated } from '@tabs/files/lib/store';
import { listSystems } from '@tabs/agents/lib/store';
import { listFolders } from '@core/folders/index';
import { inDomainScope, narrowToDomainScope } from '@core/kernel/domain-scope';
import type { ContextKind } from '@core/kernel/context-grants';
import type { CurrentUser } from '@core/kernel/auth';

/**
 * The SERVER-SIDE grantable-context feed — the SAME canView/RLS-scoped lists the
 * `/api/context/available` route serves the ContextGrants picker, lifted so the
 * governed Software assistant route can read them directly (without a self-fetch) and
 * ground its Define-stage grant suggestions in REAL, DLS-scoped ids. One source of
 * truth for "what may this caller grant".
 *
 * DOMAIN SCOPE (2026-11-18). Every lister scopes to `principal.domains`, which is the union of
 * the caller's memberships whenever no single active domain is chosen — so a user in several
 * domains was offered all of them at once (the same defect the agents grant feed had). Each
 * row now carries its own `domain` and is filtered through the shared
 * `@core/kernel/domain-scope` predicate against `user.activeDomain`, the way `/api/folders`
 * narrows its rail. With NO active domain ("All domains") the target is `null` and NOTHING is
 * narrowed — that is deliberate: there is no single domain to narrow to, and picking one would
 * hide artifacts the user explicitly asked to see across domains. Narrowing is presentation
 * only; the canView/RLS gate inside each lister remains the authorisation decision.
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

/** The caller's active operating domain, or null = all domains (⇒ no narrowing). */
function targetDomainOf(user: CurrentUser): string | null {
  return user.activeDomain ?? null;
}

/** The grantable artifacts of ONE kind the caller can see (personal + domain + marketplace),
 *  narrowed to the active domain. Each row carries its own `domain` for the predicate; the
 *  field is dropped again on the way out, so the wire shape is unchanged. */
async function forKind(kind: ContextKind, user: CurrentUser): Promise<AvailableContextItem[]> {
  const rows = await rowsForKind(kind, user);
  return narrowToDomainScope(rows, targetDomainOf(user)).map(({ domain: _domain, ...item }) => item);
}

/** One kind's rows as its owning tab lists them, each tagged with its home domain. */
async function rowsForKind(
  kind: ContextKind,
  user: CurrentUser,
): Promise<(AvailableContextItem & { domain?: string | null })[]> {
  const principal = { id: user.id, domains: user.domains, role: user.role };
  if (kind === 'data') {
    await ensureDataHydrated();
    const g = listDatasets(principal);
    return [
      ...g.mine.map((d) => ({ id: d.id, name: d.name, scope: 'personal' as const, domain: d.domain, folder: d.folder ?? '/' })),
      ...g.domain.map((d) => ({ id: d.id, name: d.name, scope: 'domain' as const, domain: d.domain, folder: d.folder ?? '/' })),
      ...g.marketplace.map((d) => ({ id: d.id, name: d.name, scope: 'marketplace' as const, domain: d.domain })),
    ];
  }
  if (kind === 'knowledge') {
    await Promise.all([ensureWorkflowsHydrated(), ensurePersonalHydrated()]);
    const wf = listWorkflows(principal);
    const pk = listPersonalKnowledge(principal);
    return [
      // Workflows carry no folder registry — they show at root.
      ...wf.mine.map((w) => ({ id: w.id, name: w.title, scope: 'personal' as const, domain: w.domain, folder: '/' })),
      ...wf.domain.map((w) => ({ id: w.id, name: w.title, scope: 'domain' as const, domain: w.domain, folder: '/' })),
      ...wf.marketplace.map((w) => ({ id: w.id, name: w.title, scope: 'marketplace' as const, domain: w.domain })),
      ...pk.mine.map((p) => ({ id: p.id, name: p.title, scope: 'personal' as const, domain: p.domain, folder: p.folder ?? '/' })),
      ...pk.domain.map((p) => ({ id: p.id, name: p.title, scope: 'domain' as const, domain: p.domain, folder: p.folder ?? '/' })),
      ...pk.marketplace.map((p) => ({ id: p.id, name: p.title, scope: 'marketplace' as const, domain: p.domain })),
    ];
  }
  if (kind === 'files') {
    await ensureFilesHydrated();
    const g = listFiles(principal);
    return [
      ...g.mine.map((f) => ({ id: f.id, name: f.name, scope: 'personal' as const, domain: f.domain, folder: f.folder ?? '/' })),
      ...g.domain.map((f) => ({ id: f.id, name: f.name, scope: 'domain' as const, domain: f.domain, folder: f.folder ?? '/' })),
      ...g.marketplace.map((f) => ({ id: f.id, name: f.name, scope: 'marketplace' as const, domain: f.domain })),
    ];
  }
  if (kind === 'metrics') {
    await ensureDataHydrated();
    const g = listMetrics(principal);
    const nm = (m: { datasetName: string; name: string }) => `${m.datasetName} · ${m.name}`;
    return [
      // A metric's domain rides from its owning dataset (absent ⇒ a domainless dataset).
      ...g.mine.map((m) => ({ id: m.id, name: nm(m), scope: 'personal' as const, domain: m.domain })),
      ...g.domain.map((m) => ({ id: m.id, name: nm(m), scope: 'domain' as const, domain: m.domain })),
      ...g.marketplace.map((m) => ({ id: m.id, name: nm(m), scope: 'marketplace' as const, domain: m.domain })),
    ];
  }
  // connections — the async, already canView-scoped list.
  const conns = await listConnectionsForUser(user);
  return conns.map((c) => ({
    id: c.id,
    name: c.name,
    domain: c.domain,
    scope: c.visibility === 'Certified' ? 'marketplace' : c.visibility === 'Shared' ? 'domain' : 'personal',
  }));
}

/**
 * The grantable AGENTS the caller can see — the SIXTH Choose-Context type (Phase 4b). Agents
 * are NOT a core `ContextKind` (they ride the separate `app.grants.agents` list), so they have
 * their own feed, shaped identically to `AvailableContextItem` so the picker reuses the same UI.
 * Personal/Shared/Marketplace → personal/domain/marketplace, matching the other kinds.
 */
export async function availableAgents(user: CurrentUser): Promise<AvailableContextItem[]> {
  const principal = { id: user.id, domains: user.domains, role: user.role };
  const g = listSystems(principal);
  return [
    ...g.mine.map((s) => ({ id: s.id, name: s.name, scope: 'personal' as const })),
    ...g.domain.map((s) => ({ id: s.id, name: s.name, scope: 'domain' as const })),
    ...g.marketplace.map((s) => ({ id: s.id, name: s.name, scope: 'marketplace' as const })),
  ];
}

/**
 * The folder rows (personal + domain) a foldered kind exposes to the grant tree, narrowed to
 * the active domain by the SAME predicate the items use.
 *
 * Deliberately NOT `listFolders(..., { activeDomain })`: that option drops a row whose
 * `domain` is empty, while `inDomainScope` keeps a domainless artifact (an admin must still be
 * able to find and file an unassigned one). Using the option here made an unstamped folder
 * vanish from the picker even though its items were listed.
 */
function foldersForKind(kind: ContextKind, user: CurrentUser): AvailableFolder[] {
  if (!FOLDERED_KINDS.includes(kind)) return [];
  const tab = KIND_TAB[kind as 'data' | 'knowledge' | 'files'];
  const principal = { id: user.id, domains: user.domains, role: user.role };
  const target = targetDomainOf(user);
  const keep = (scope: 'personal' | 'domain') => (f: { domain: string }) =>
    inDomainScope({ scope, domain: f.domain }, target);
  try {
    const personal = listFolders(principal, tab, 'personal')
      .filter(keep('personal'))
      .map((f) => ({ path: f.path, scope: 'personal' as const }));
    const domain = listFolders(principal, tab, 'domain')
      .filter(keep('domain'))
      .map((f) => ({ path: f.path, scope: 'domain' as const }));
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
