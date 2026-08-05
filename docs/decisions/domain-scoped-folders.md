# Domain-scoped folders (design + implementation plan)

Status: proposed
Date: 2026-07-28
Scope: `os-ui` folder registry + the 4 foldered tabs (data, knowledge, files, metrics)

---

## 1. The bug, restated

Switching the active DOMAIN (sidebar `DomainSwitcher`) does not change the folder
tree. Folders must be scoped by BOTH the tier (My / Domain / Company — internal
enums `personal` / `domain`) AND the specific domain the user is operating in
(`agentic-leader-q3-2026`, `test`, `kiekert`, `europace`, …).

## 2. SEVERITY VERDICT — DISPLAY-ONLY BUG (not a cross-domain leak)

The folder-TREE labels ignore the active domain, but the ARTIFACTS inside every
tab are still correctly domain-filtered. Proof, concrete code:

- Folder rail is fed by `useFolders` → `GET /api/folders?tab=…&scope=…`. No
  `domain=` param is ever sent (`os-ui/lib/folders/useFolders.ts:37-40`,
  `os-ui/app/api/folders/route.ts:35-41`).
- Server `listFolders` (`os-ui/lib/folders/folder-store.ts:176-193`):
  - `scope === 'personal'` → filters **only** `n.owner === viewer.id`. Domain is
    never consulted → the My/Personal tree is identical in every domain. **This
    is the visible bug.**
  - `scope === 'domain'` → filters `viewer.domains.includes(n.domain)`. Because
    `user.domains` is already narrowed to `[activeDomain]` (see below), the DOMAIN
    tree *does* re-scope correctly when a domain is chosen; it only shows all
    domains' folders in the "All domains" view (expected).
- The active domain IS applied server-side: `currentUser()` narrows
  `user.domains` to `[active]` via `resolveDomainScope`
  (`os-ui/lib/core/auth.ts:54-64`, `os-ui/lib/core/active-domain.ts:41-44`), and
  the switcher does a full `window.location.reload()`
  (`os-ui/components/core/DomainSwitcher.tsx:58`) so every client fetch re-runs.
  So this is NOT a stale-cache/UI-keying bug.
- The CONTENTS are domain-safe. The personal ("My") artifact lists filter on the
  narrowed `user.domains`:
  - Data: `os-ui/lib/data/store.ts:390` — `else if (!d.domain || user.domains.includes(d.domain)) mine.push(...)`.
  - Files: `os-ui/lib/files/store.ts:374-381` — `const inScope = !a.domain || user.domains.includes(a.domain); … if (inScope) mine.push(s)`.
  - Metrics: inherits data's grouping (`os-ui/lib/metrics/store.ts:91-104`).

  So even though the personal FOLDER labels are shared, the datasets/files/metrics
  shown INSIDE them re-scope to the active domain. No artifact crosses a domain
  boundary.

One honest caveat (still not a leak): **knowledge** personal ("mine") items are
gated by `canView` = owner-only (`os-ui/lib/knowledge/personal-store.ts:132,184-188`)
and are NOT filtered by active domain. That is owner-scoped, so no cross-user
leak, but it is inconsistent with data/files and should be aligned in the same
change so knowledge folders+contents also re-scope by domain.

Bottom line: **display-only** for data/files/metrics (folder labels ignore
domain; contents are safe); knowledge additionally shows all of the owner's own
items regardless of domain. No path lets a user see another domain's folder
contents.

## 3. ROOT CAUSE (one paragraph)

The durable `FolderNode` already carries a `domain` field
(`os-ui/lib/folders/folder-store.ts:52-64`), but the personal read path never
uses it. `listFolders` keys personal folders on owner alone
(`folder-store.ts:186-187`), `findByPath` dedups personal folders on owner alone
(`folder-store.ts:160-167`), and neither the API GET
(`app/api/folders/route.ts:35-41`) nor `useFolders`
(`lib/folders/useFolders.ts`) carries an active-domain dimension. Consequently a
user's personal folder tree is a single flat set spanning all their domains,
identical no matter which domain is active — the domain dimension is simply
missing from the folder read/dedup, even though the store row records it.

## 4. RECOMMENDED DESIGN (simplest correct)

Add the active domain as an explicit read/dedup dimension for personal folders,
reusing the existing `FolderNode.domain` field — no schema change, minimal churn.

1. `listFolders` gains an `activeDomain: string | null` param. Personal branch:
   keep `owner === viewer.id` AND, when `activeDomain` is set, also require
   `n.domain === activeDomain`; when null ("All domains"), return all owner rows
   (matches how "All" shows all artifacts). Domain branch unchanged (already
   narrows via `viewer.domains`; passing `activeDomain` lets it hard-filter to
   the one active domain instead of "any of my domains" for consistency).
2. `findByPath` (personal) dedups on `(owner, domain, path)` so the same folder
   name can exist independently per domain — the fix that makes trees diverge.
3. `createFolder` already stamps `domain`; make it stamp the ACTIVE domain, not
   `user.domains[0]`. Pass `activeDomain` down so a personal folder is minted in
   the domain the user is operating in (when "All", fall back to `domains[0]` as
   today — a pre-existing edge, unchanged).
4. API: `GET /api/folders` reads `user.activeDomain` (already on `CurrentUser`)
   and passes it to `listFolders`. POST passes it to `createFolder`. `withRoute`
   already exposes the full `user` (`CurrentUser`), so `activeDomain` is in hand
   — no signature change to the wrapper.
5. UI: `useFolders` + the knowledge page fetch need NO new param — the server
   derives the domain from the session cookie, and the switcher's hard reload
   already re-fetches. (Optional: thread `activeDomain` for cache-key clarity.)
6. Governance unchanged: reuse `canManageArtifact` via the existing `gateArt`
   (`folder-store.ts:149-158`). My = owner-only (personal scope closes the
   admin/domain_admin gap already); Domain = owner + in-domain `domain_admin` +
   platform `admin`; create-domain-folder still requires `domain_admin`/`admin`
   (`folder-store.ts:234-236`). No parallel authz.
7. Knowledge alignment: filter personal knowledge "mine" by active domain the
   same way data/files do, so its folders+contents re-scope together.

### Migration (nothing orphaned)

Existing personal `FolderNode` rows already have a `domain` (stamped at create,
historically `user.domains[0]`). After the fix, a personal folder is only visible
when the active domain equals its stored `domain`. For single-domain users this
is a no-op. For multi-domain users, existing personal folders will "belong" to
whichever domain was `domains[0]` at creation — they are NOT deleted, just shown
only under that domain. Provide a one-shot idempotent backfill/repair that leaves
rows intact (no re-homing) and, if desired, logs personal folders whose `domain`
is not in the owner's current membership so an admin can review. Same for
artifact `path` fields — untouched; only the folder REGISTRY read changes.

## 5. TESTS TO ADD

Unit (`os-ui/lib/folders/folder-store.test.ts`):
- Two personal folders, same path, different domain, same owner → `listFolders`
  with `activeDomain=A` returns only A's; with `B` only B's; with `null` returns
  both.
- `findByPath` treats `(owner, path)` in domain A vs B as distinct (create in A
  then in B yields two rows, not one).
- `createFolder` personal stamps the passed active domain (not `domains[0]`).
- Domain-scope: `listFolders(scope=domain, activeDomain=A)` excludes folders of
  another of the viewer's domains B.
- Governance regression: personal folder in domain A is still owner-only;
  domain folder still requires domain_admin/admin to create.

Integration (per-tab adapter tests + API route test):
- `GET /api/folders?tab=data&scope=personal` under active domain A vs B returns
  disjoint trees (mock two active-domain sessions).
- End-to-end per foldered tab (data, files, metrics, knowledge): a folder + its
  member artifact created in A is absent from the tree AND the tile list when B
  is active, present when A is active.
- Knowledge: personal "mine" items now filter by active domain (regression that
  they no longer show across domains).

## 6. ORDERED IMPLEMENTATION CHECKLIST (files to change)

1. `os-ui/lib/folders/folder-store.ts`
   - `listFolders(viewer, tab, scope, opts)` → add `activeDomain: string | null`
     (via `opts.activeDomain`); personal branch also requires
     `!activeDomain || n.domain === activeDomain`; domain branch hard-filters to
     `activeDomain` when set.
   - `findByPath` → key personal on `(owner, domain, path)`.
   - `createFolder` → accept/stamp the active domain for personal folders.
2. `os-ui/app/api/folders/route.ts`
   - GET: pass `user.activeDomain` into `listFolders`.
   - POST: pass `user.activeDomain` into `createFolder`.
3. `os-ui/lib/folders/folder-lifecycle.ts` — verify move/archive/restore/delete
   cascades still scope on `(owner|domain, domain)`; adjust
   `folderAndDescendants` peers filter (`folder-store.ts:199-207`) so a personal
   cascade stays within the folder's own domain (add `n.domain === node.domain`).
4. `os-ui/lib/knowledge/personal-store.ts` — filter `listPersonalKnowledge` "mine"
   by active domain (align with data/files); pass activeDomain from its route.
   Verify the knowledge folder adapter/rail then re-scopes.
5. Tabs — no logic change expected (they read `listDatasets`/`listFiles`/etc.
   which already narrow via `user.domains`); confirm each folder adapter's
   `itemsInScope` still lines up with the now-domain-scoped folder rows:
   `os-ui/lib/data/folder-adapter.ts`, `lib/files/folder-adapter.ts`,
   `lib/metrics/folder-adapter.ts`, `lib/knowledge/folder-adapter.ts`.
6. `os-ui/lib/folders/useFolders.ts` + `app/(context)/knowledge/page.tsx` —
   optional: thread `activeDomain` into the fetch cache key for clarity (server
   already derives it from the cookie; behavior is correct without this).
7. Tests — add the unit + integration cases in §5.
8. One-shot idempotent backfill/repair note (no re-homing) per §5 migration; log
   personal folders whose `domain` is outside owner's current membership.

### Non-goals / out of scope
- Connections, dashboards, software, agents do NOT use this folder registry
  (`FolderTab = 'files' | 'knowledge' | 'data' | 'metrics'`); they use grant/
  context folders (`lib/agents/grant-folders.ts`, `lib/software/available-context.ts`)
  which are computed from already-domain-scoped artifact lists — no change here.
- Do not touch `os-ui/components/software/**` or agents-tab files (change in flight).
</content>
</invoke>
