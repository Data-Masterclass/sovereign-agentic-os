/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import { getSystem } from '@tabs/agents/lib/store';
import { listDatasets, ensureHydrated } from '@tabs/data/lib/store';
import { listWorkflows, ensureHydrated as ensureWorkflowsHydrated } from '@tabs/knowledge/lib/store';
import { listPersonalKnowledge, ensureHydrated as ensurePersonalHydrated } from '@tabs/knowledge/lib/personal-store';
import { listMetrics } from '@tabs/metrics/lib/store';
import { listConnectionsForUser } from '@tabs/connections/lib/index';
import { listFiles, ensureHydrated as ensureFilesHydrated } from '@tabs/files/lib/store';
import { listFolders, ensureHydrated as ensureFoldersHydrated } from '@core/folders/index';
import { buildGrantFeed, type GrantFeedInput } from '@tabs/agents/lib/grant-feed';
import { grantWarningsForKind } from '@tabs/agents/lib/build/grant-access-probe';
import type { GrantCheckKind } from '@tabs/agents/lib/grant-access';
import { resolveManual } from '@tabs/knowledge/lib/manual';
import {
  MANUAL_SCOPES,
  planGrantId,
  manualLabel,
  manualAvailableScope,
} from '@tabs/agents/lib/plan-grants';

export const dynamic = 'force-dynamic';

/**
 * GET → the artifacts of a given `kind` the caller can actually see, so the
 * Grants & Routing picker can BROWSE + choose per-artifact access rather than
 * paste a raw id. Every
 * item is produced by the SAME canView/role-scoped list the rest of the OS uses
 * (personal + own-domain shared + marketplace), so this never leaks another
 * user's private drafts or another domain's artifacts.
 *
 * DOMAIN SCOPE (2026-11-18). The feed is narrowed to the SYSTEM's own domain, not to the union
 * of every domain the caller belongs to: an admin in four domains editing a system in one of
 * them was offered all four domains' folders (incl. their personal folders elsewhere), because
 * every lister scopes to `principal.domains` and `user.domains` is narrowed only when a single
 * active domain is chosen. The narrowing is PRESENTATION — every row was already canView/DLS
 * filtered, and `tabs/agents/lib/build/os-tools.ts` still re-resolves each grant per item
 * against the acting principal at build/run. Marketplace items and the operating-manual scopes
 * are NOT narrowed; a folder grant that already points outside the domain comes back flagged
 * `outsideDomain` so the picker warns instead of silently dropping it (and
 * `tabs/agents/lib/grant-apply.ts` keeps the tree's round trip from deleting it).
 *
 * This feed is a PICKER, not a gate. Nothing validates granted ids when `system.yaml` is
 * written — that PUT is edit-scoped and sha-checked, and takes the document as given (it only
 * RETURNS `grantWarnings` for grants the saver cannot use, `tabs/agents/lib/grant-access.ts`) — so the
 * guarantees come from elsewhere: the canView/DLS filter inside each lister bounds what is
 * ever OFFERED, and at build/run every granted tool call executes as the acting principal
 * under OPA + row/document-level security. A narrower feed is a better picker, never a
 * tighter permission. See
 * `tabs/agents/lib/grant-feed.ts` + `docs/superpowers/plans/2026-11-18-grant-picker-domain-scope.md`.
 *
 * Response: `{ items: [{ id, name, scope, folder? }], folders?: [{ path, scope, outsideDomain? }], grantWarnings }`
 * — `grantWarnings` lists this kind's grants the CALLER cannot use (`tabs/agents/lib/grant-access.ts`).
 * DATA items additionally carry `layers` (which medallion layers are BUILT) so the
 * grant picker only ever offers a real, queryable Bronze/Silver/Gold choice. For the
 * FOLDERED kinds (data · knowledge · files) each item carries its `folder` path AND
 * the response returns the folder nodes for the personal + domain trees, so the
 * Wave-3 checkbox tree can render folders + items and emit folder grants. The feed is
 * ALREADY DLS-scoped, so a folder that holds ungrantable items simply shows fewer
 * items — the tree renders tri-state and the "grants N of M" honesty follows.
 *
 * The Plan-item kind returns grantable PLAN targets rather than raw artifacts:
 * `operating-manual` (the manual scopes the caller may view). Each item's `id` is the
 * encoded `grants.plan` id (`manual:*`) and its `scope` groups it My/Domain/Company like
 * the others, using the SAME RLS/DLS gate the Operating-Manual tab uses, so nothing the
 * caller can't see is ever offered.
 */
// `connections` (plural) is the Simple-builder GrantKind spelling; `connection`
// (singular) is the original Grants-panel spelling — both resolve to the same list.
type Kind =
  | 'data' | 'knowledge' | 'workflows' | 'files' | 'connection' | 'connections' | 'metric'
  | 'operating-manual';
const KINDS: Kind[] = [
  'data', 'knowledge', 'workflows', 'files', 'connection', 'connections', 'metric',
  'operating-manual',
];

/** The feed kind → the `grants.*` list it edits, for the grant warnings. */
const GRANT_CHECK_KIND: Partial<Record<Kind, GrantCheckKind>> = {
  data: 'data', knowledge: 'knowledge', workflows: 'workflows', files: 'files',
  connection: 'connections', connections: 'connections', metric: 'metrics',
};

/** The kinds that carry folders — the ones whose feed returns folder nodes. */
const FOLDER_TABS: Record<string, 'data' | 'knowledge' | 'files'> = { data: 'data', knowledge: 'knowledge', files: 'files' };

/** Each lister's rows, carrying the item's OWN domain so the feed can narrow on it.
 *  `domain` is stripped before the response — the picker never reads it. */
type Item = GrantFeedInput;

/** The built medallion layers of a dataset summary, from its B/S/G dots. */
function builtLayers(dots: { bronze: boolean; silver: boolean; gold: boolean }): ('bronze' | 'silver' | 'gold')[] {
  const out: ('bronze' | 'silver' | 'gold')[] = [];
  if (dots.bronze) out.push('bronze');
  if (dots.silver) out.push('silver');
  if (dots.gold) out.push('gold');
  return out;
}

export const GET = withRoute<{ id: string }>(async ({ user, params, req }) => {
    const { id } = params;
    const principal = { id: user.id, domains: user.domains, role: user.role };

    // Scope gate: confirm the caller can view this system (throws 403/404) — and read the
    // narrowing target from the SAME record, so the feed shows the domain of the system under
    // edit rather than everything this caller may see. A domainless system narrows nothing.
    const sys = getSystem(id, principal);
    const targetDomain = sys.domain || null;

    const kind = new URL(req.url).searchParams.get('kind') as Kind | null;
    if (!kind || !KINDS.includes(kind)) {
      return NextResponse.json({ error: `kind must be one of: ${KINDS.join(', ')}` }, { status: 400 });
    }

    let items: Item[] = [];
    if (kind === 'data') {
      await ensureHydrated();
      const g = listDatasets(principal);
      items = [
        ...g.mine.map((d) => ({ id: d.id, name: d.name, scope: 'personal' as const, domain: d.domain, layers: builtLayers(d.dots), folder: d.folder })),
        ...g.domain.map((d) => ({ id: d.id, name: d.name, scope: 'domain' as const, domain: d.domain, layers: builtLayers(d.dots), folder: d.folder })),
        ...g.marketplace.map((d) => ({ id: d.id, name: d.name, scope: 'marketplace' as const, domain: d.domain, layers: builtLayers(d.dots), folder: d.folder })),
      ];
    } else if (kind === 'knowledge') {
      // Knowledge NOTES (pk_xxx) only — foldered. A workflow is a different artifact with its own feed.
      await ensurePersonalHydrated();
      const pk = listPersonalKnowledge(principal);
      items = [
        ...pk.mine.map((p) => ({ id: p.id, name: p.title, scope: 'personal' as const, domain: p.domain, folder: p.folder })),
        ...pk.domain.map((p) => ({ id: p.id, name: p.title, scope: 'domain' as const, domain: p.domain, folder: p.folder })),
        ...pk.marketplace.map((p) => ({ id: p.id, name: p.title, scope: 'marketplace' as const, domain: p.domain, folder: p.folder })),
      ];
    } else if (kind === 'workflows') {
      // Workflows (wf_xxx) only — no folder support ⇒ live at root.
      await ensureWorkflowsHydrated();
      const wf = listWorkflows(principal);
      items = [
        ...wf.mine.map((w) => ({ id: w.id, name: w.title, scope: 'personal' as const, domain: w.domain, folder: '/' })),
        ...wf.domain.map((w) => ({ id: w.id, name: w.title, scope: 'domain' as const, domain: w.domain, folder: '/' })),
        ...wf.marketplace.map((w) => ({ id: w.id, name: w.title, scope: 'marketplace' as const, domain: w.domain, folder: '/' })),
      ];
    } else if (kind === 'files') {
      await ensureFilesHydrated();
      const g = listFiles(principal);
      items = [
        ...g.mine.map((f) => ({ id: f.id, name: f.name, scope: 'personal' as const, domain: f.domain, folder: f.folder })),
        ...g.domain.map((f) => ({ id: f.id, name: f.name, scope: 'domain' as const, domain: f.domain, folder: f.folder })),
        ...g.marketplace.map((f) => ({ id: f.id, name: f.name, scope: 'marketplace' as const, domain: f.domain, folder: f.folder })),
      ];
    } else if (kind === 'metric') {
      await ensureHydrated();
      const g = listMetrics(principal);
      const nm = (m: { datasetName: string; name: string }) => `${m.datasetName} · ${m.name}`;
      items = [
        // A metric's domain rides from its owning dataset (absent ⇒ a domainless dataset).
        ...g.mine.map((m) => ({ id: m.id, name: nm(m), scope: 'personal' as const, domain: m.domain })),
        ...g.domain.map((m) => ({ id: m.id, name: nm(m), scope: 'domain' as const, domain: m.domain })),
        ...g.marketplace.map((m) => ({ id: m.id, name: nm(m), scope: 'marketplace' as const, domain: m.domain })),
      ];
    } else if (kind === 'operating-manual') {
      // The three Operating-Manual scopes the caller may VIEW — gated by the SAME
      // `resolveManual` the Operating-Manual tab uses (My = own, Domain = in-domain,
      // Company = everyone). Each grantable item's id encodes its scope (`manual:<scope>`)
      // so the grant records the exact governed target; granting provisions the read tool.
      items = MANUAL_SCOPES
        .filter((scope) => resolveManual(scope, principal).canView)
        .map((scope) => ({ id: planGrantId(scope), name: manualLabel(scope), scope: manualAvailableScope(scope) }));
    } else {

      // connection / connections — the async, already canView-scoped list.
      const conns = await listConnectionsForUser(user);
      items = conns.map((c) => ({
        id: c.id,
        name: c.name,
        domain: c.domain,
        scope:
          c.visibility === 'Certified' ? 'marketplace' : c.visibility === 'Shared' ? 'domain' : 'personal',
      }));
    }

    // For the foldered kinds, also return the folder nodes (personal + domain trees)
    // so the Wave-3 checkbox tree can render folders alongside items. Two sources are
    // UNIONED so the tree is never blank when items sit in a folder:
    //   1. the governed `listFolders(viewer, tab, scope)` registry rows (explicit, incl.
    //      EMPTY folders) — the SAME the tabs use, never another user's private tree;
    //   2. the IMPLICIT ancestor folders synthesized from each grantable item's own
    //      `folder` path. Files use an implicit-rail model (a file's folder often exists
    //      only as a path on the file, with no registry row), so without this the Files
    //      section rendered BLANK even though the user has folders. Data/Knowledge get
    //      the same union for consistency. Every synthesized node inherits ITS ITEM's
    //      scope (marketplace items fold under no tree — the picker only trees My/Domain).
    // The registry rows are read UNNARROWED and filtered by the feed's own predicate. Note
    // the asymmetry that forced this: `listFolders`' `activeDomain` option drops a row whose
    // `domain` is empty, while the feed deliberately KEEPS a domainless artifact (an admin has
    // to be able to find and file it). Passing `activeDomain` here therefore made an
    // unstamped folder vanish from the tree — and, if it was granted, show up as "outside this
    // domain", which it is not. The folder grants the system ALREADY holds go in too, so a
    // legacy one pointing outside this domain comes back flagged instead of disappearing.
    const tab = FOLDER_TABS[kind];
    let explicitFolders: { path: string; scope: 'personal' | 'domain'; domain: string }[] | undefined;
    let grantedFolders: { path: string; scope: 'personal' | 'domain' }[] | undefined;
    if (tab) {
      await ensureFoldersHydrated();
      const viewer = { id: user.id, role: user.role, domains: user.domains };
      explicitFolders = [
        ...listFolders(viewer, tab, 'personal')
          .map((f) => ({ path: f.path, scope: 'personal' as const, domain: f.domain })),
        ...listFolders(viewer, tab, 'domain')
          .map((f) => ({ path: f.path, scope: 'domain' as const, domain: f.domain })),
      ];
      grantedFolders = (sys.system.grants[tab] ?? [])
        .map((g) => g.folder)
        .filter((f): f is NonNullable<typeof f> => !!f)
        .map((f) => ({ path: f.path, scope: f.scope }));
    }

    const feed = buildGrantFeed({
      items,
      domain: targetDomain,
      explicitFolders,
      grantedFolders,
      withFolders: !!tab,
    });
    // GRANT WARNINGS (2026-11-23). A granted id the feed did not return is one this picker cannot
    // show — it may be private to someone else, gone, or outside the team's domain. Resolve each
    // such grant as the caller (`grantWarningsForKind`, the governed `get_*` door) so the chip
    // can say WHICH, and what to do. Ids the feed did return are visible and never re-probed.
    // Never names a resource the caller cannot see; never a gate.
    const checkKind = GRANT_CHECK_KIND[kind];
    const grantWarnings = checkKind
      ? await grantWarningsForKind(user, sys.system, checkKind, new Set(feed.items.map((i) => i.id)))
      : [];
    return NextResponse.json(
      feed.folders ? { items: feed.items, folders: feed.folders, grantWarnings } : { items: feed.items, grantWarnings },
    );
}, { defaultStatus: 500 });
