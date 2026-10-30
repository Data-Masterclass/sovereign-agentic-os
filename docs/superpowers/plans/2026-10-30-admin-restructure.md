# Admin → Platform restructure: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax.

**Goal:** Admin stops being the place things land when nobody knows where they go. Seventeen sections become six, each remaining one genuinely tenant administration, with **no new top-level tabs**.

**Architecture:** `tabs/admin/lib/sections.ts` is already the single source of truth for the menu, and `/platform` renders it as a grouped tile grid. So most of this is moving entries between owners and giving three arrivals a home, not rebuilding navigation.

**Tech stack:** Next.js app router, `os-ui/core/kernel/tabs.ts` for the nav, `os-ui/tabs/<tab>/lib|ui` per tab, role gates via `roleAtLeast`.

## Test-harness limitation (found in Task 2 — read before writing UI tests)

**A `.tsx` file cannot be imported from a test.** Node's type-stripping does not
handle JSX and `scripts/test-alias-hook.mjs` has no `load` hook to transform it,
so `import { X } from './Thing.tsx'` fails with `ERR_UNKNOWN_FILE_EXTENSION`
before it ever reaches your assertion. Two further blockers sit behind it:
importing `.svg` fails the same way, and `next/navigation` fails with
`ERR_MODULE_NOT_FOUND` under plain node.

**So: put anything you want to unit-test in a data-only `.ts` sibling** and
re-export it from the component, exactly as `core/ui/account-menu.ts` does for
`Sidebar.tsx`, and as `tabs/admin/lib/sections.ts` does for the Platform page.
Test the `.ts` file. Do not try to make the harness transform JSX as part of a
feature task; that is its own piece of work.

## Global constraints

- **13 top-level tabs stay 13.** This plan adds none. The four groups the user originally wanted as tabs become the Platform page's structure instead. Nav position tracks **frequency**, not importance.
- **Rename the tab label Admin → Platform.** Keep the route `/platform`; it already is that.
- **Never break per-user OAuth.** `tabs/connections/lib/connections-drive-oauth.test.ts` asserts only the owner can store tokens or sync. An admin cannot hold another person's token, so personal account linking must keep a self-service home or Files/Knowledge sync dies.
- Every moved surface keeps its existing `minRole`. Moving a tile must not widen access.
- Every new or moved file carries the `FEATURE:` / `USER STORY:` / `ARCHITECTURE:` header; `scripts/check-structure.mjs` enforces it and the baseline must not grow.

---

## The decisions behind this (do not relitigate without reading)

| Decision | Why |
|---|---|
| No new top-level tabs | 13 was held through the whole v2 rework; 17 would be a 30% nav expansion for admin-only surfaces. The submenu strip above the tiles was deleted on 2026-10-28 at the user's request, and spreading Admin across the global nav is the same move in another direction. |
| Three personal items leave Admin | About/Licenses is creator-level, My MCP access and My Settings are builder-level. Personal settings inside an admin menu is a category error, not a grouping problem. |
| Cost & Billing → Monitoring | The billing envelope is **display-only** (see the comment in `core/kernel/config.ts`); real enforcement lives in LiteLLM budgets. The whole surface is observation, so nothing stays behind. |
| MCPs & APIs, Drive OAuth apps, Plugins → Connections | All three are registries of what the tenant admits. `tabs/admin/lib/plugins.ts` says it curates "MCP servers, skills, tool bundles", which **overlaps MCPs & APIs** — one surface split across two tiles. |
| Role *definitions* → Governance, role *assignment* stays | Defining what a role may do is policy: rare, high-stakes, auditable, belongs beside approvals and OPA. Assigning a person a role is routine administration and belongs with Users & Access. Splitting both would make admins bounce between tabs for one task. |
| Connections stays creator-visible | **Settled 2026-10-30 by the user: "Creator can see their connections."** So the tab is NOT made admin-only. The three registries become an explicitly admin-gated SECTION inside it, visually separate from a person's own connection list. The tab then answers two questions — "what am I connected to" and "what may this tenant connect to" — so the admin block needs its own heading, or a creator sees tiles they cannot use. |
| OS-published MCP endpoints leave the registry | `tabs/admin/lib/mcp-registry.ts` carries `kind: 'api'` rows pointing at the OS's own endpoints (`/api/gateway` among them). Those were never trust decisions; listing them buries the few third-party servers an admin actually vouched for. |
| Security & Egress → Governance | Settled 2026-10-30: the egress allowlist reads as policy, and it sits naturally beside the OPA policy view. |
| Roles & Permissions → Governance **whole**, not split | Settled 2026-10-30. The earlier plan split definition from assignment; the user chose to move the entire surface. Assignment of a role to a person stays reachable from Users & Access, which remains in Platform, via a cross-link. |

**Target Platform, six tabs** (settled 2026-10-30)

1. **Overview & Health** — Overview merged with Components & System
2. **Domains**
3. **Tenant Settings**
4. **Users & Access**
5. **Models & Providers**
6. **Backups & Restore**

Two changes from the eight-tab version:

* **Overview and Components & System are consolidated.** They overlapped: both
  reported what is running and whether it is healthy.
* **No LLM Gateway tile.** Removed while the embedded console is unverified in
  production. Restoring it is one entry pointing at `/tools/litellm/ui`.

**The merge has a role trap.** Overview is `minRole: 'builder'` and is the ONLY
Platform surface a builder can see; Components & System is `admin`. Merging at
`admin` would leave builders with a Platform tab containing nothing. So the
merged tab must be **builder-readable with admin-only actions**: a builder sees
status, only an admin can enable or disable a component. Do not merge by taking
the stricter role.

At six tabs the three group headings carry little, so the strip can be flat.
Keep `ADMIN_GROUP_ORDER` only if the tabs visibly separate.

Individual users are set up here, in Platform. Only the *definition* of what a
role may do lives in Governance.

---

## File structure

| File | Responsibility after this plan |
|---|---|
| `os-ui/tabs/admin/lib/sections.ts` | Six Platform sections, three groups. Loses ten of sixteen. |
| `os-ui/tabs/admin/lib/sections.test.ts` | Extended: asserts what Platform must **not** contain, so a regression re-adding a moved tile fails CI. |
| `os-ui/core/kernel/tabs.ts` | Tab label `Admin` → `Platform`. |
| `os-ui/core/ui/Sidebar.tsx` | Gains the account menu holding the three personal items. |
| `os-ui/tabs/connections/lib/registries.ts` *(new)* | The three admin registries as one admin-gated surface. |
| `os-ui/tabs/connections/ui/AdminRegistries.tsx` *(new)* | Renders it on the Connections page, explicitly admin-only. |
| `os-ui/tabs/monitoring/lib/spend.ts` | Absorbs the billing view. |
| `os-ui/tabs/governance/lib/roles.ts` | Absorbs role **definitions**. |
| `os-ui/tabs/admin/lib/mcp-registry.ts` | Drops `kind: 'api'` self-published rows. |

---

## Task 1: Rename Admin → Platform, and pin the target shape

**DONE — `7bcf8729`** (2026-10-30). All six steps as written, except Step 6's commit
message, which says "six sections in three groups": nine was a leftover from an earlier
draft and six is the settled number.

**Files:** modify `os-ui/core/kernel/tabs.ts`, `os-ui/tabs/admin/lib/sections.ts`, `os-ui/tabs/admin/lib/sections.test.ts`

**Interfaces:**
- Produces: `ADMIN_GROUP_ORDER` becomes `['Tenant', 'Models', 'Infrastructure']`; later tasks rely on those exact strings.

- [x] **Step 1: Write the failing test.** In `sections.test.ts`:

```ts
test('PLATFORM: holds only tenant administration', () => {
  const ids = ADMIN_SECTIONS.map((s) => s.id).sort();
  assert.deepEqual(ids, [
    'access', 'backups', 'domains', 'models', 'overview', 'settings',
  ]);  // 'overview' is the merged Overview & Health; no 'components', no 'gateway'
});

test('PLATFORM: the moved surfaces are gone', () => {
  for (const gone of ['billing', 'roles', 'security', 'plugins', 'mcp-apis', 'oauth-apps', 'my-mcp', 'my-settings', 'licenses']) {
    assert.equal(ADMIN_SECTIONS.find((s) => s.id === gone), undefined, `${gone} still in Platform`);
  }
});

test('PLATFORM: three groups, in order', () => {
  assert.deepEqual([...ADMIN_GROUP_ORDER], ['Tenant', 'Models', 'Infrastructure']);
});
```

- [x] **Step 2: Run it and watch it fail.** `cd os-ui && npm test 2>&1 | grep PLATFORM` — expect failures naming the eight surfaces still present.
- [x] **Step 3: Delete the ten moved entries** from `ADMIN_SECTIONS` (keep `access`; it stays). Set `ADMIN_GROUP_ORDER` to the three groups and move `access` to group `'Tenant'`.
- [x] **Step 4: Change the nav label.** In `core/kernel/tabs.ts`, `{ label: 'Admin', … }` → `{ label: 'Platform', … }`. Leave `href: '/platform'` and `feature: 'admin'` alone.
- [x] **Step 5: Run the suite.** `npm test` — green, and `node ../scripts/check-structure.mjs` at baseline.
- [x] **Step 6: Commit.** `git commit -m "refactor(platform): Admin becomes Platform, nine sections in three groups"`

---

## Task 2: Account menu for the three personal items

**DONE — `59d94ae8`** (2026-10-30). Steps as written, with one forced change: `ACCOUNT_ITEMS`
lives in the new data-only `core/ui/account-menu.ts` and is re-exported from `Sidebar.tsx`,
because a `.tsx` cannot be imported from a test in this harness (see the limitation above).
The test imports the `.ts` file, not `./Sidebar.tsx` as Step 1 wrote it.

No longer blocks Task 4 (the tab keeps creator access), but still worth doing: personal settings do not belong in an admin menu.

**Files:** modify `os-ui/core/ui/Sidebar.tsx`; test `os-ui/core/ui/account-menu.test.ts` *(new)*

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `ACCOUNT_ITEMS: { id: string; label: string; href: string; minRole: Role }[]`, exported from `Sidebar.tsx`, consumed by its test only.

- [x] **Step 1: Write the failing test.**

```ts
import { ACCOUNT_ITEMS } from './Sidebar.tsx';
test('ACCOUNT-MENU: carries the personal surfaces, at their original roles', () => {
  assert.deepEqual(ACCOUNT_ITEMS.map((i) => [i.id, i.href, i.minRole]), [
    ['my-settings', '/settings', 'builder'],
    ['my-mcp', '/mcp', 'builder'],
    ['licenses', '/about', 'creator'],
  ]);
});
```

- [x] **Step 2: Run it.** Expect "does not provide an export named 'ACCOUNT_ITEMS'".
- [x] **Step 3: Add `ACCOUNT_ITEMS` and render it** in the sidebar's existing user area, role-filtered with `roleAtLeast`. Keep the routes unchanged so existing bookmarks work.
- [x] **Step 4: Run tests.** Green.
- [x] **Step 5: Commit.** `git commit -m "feat(ui): personal settings move to an account menu"`

---

## Task 3: Cost & Billing → Monitoring

**DONE — `6feee6ec`** (2026-10-30). All six steps. It is a "Cost & Spend" section on
`/monitoring#spend`; the lib is `tabs/monitoring/lib/spend.ts` and the API stayed at
`/api/platform-admin/billing`. Monitoring is builder-visible, so the section is
admin-gated inside Monitoring — the move did not widen access.

**Files:** `git mv os-ui/tabs/admin/lib/billing.ts os-ui/tabs/monitoring/lib/spend.ts` (plus its test); modify `os-ui/tabs/monitoring/manifest.ts`, the Monitoring page, and delete `os-ui/app/(govern)/platform/billing/`

- [x] **Step 1:** `git mv` the lib and its test, so history follows the file.
- [x] **Step 2:** Update imports. `grep -rln "admin/lib/billing" os-ui | xargs sed -i '' 's#@tabs/admin/lib/billing#@tabs/monitoring/lib/spend#g'`
- [x] **Step 3:** Render it as a Monitoring section; add `/api/platform-admin/billing` to Monitoring's manifest `api` list and drop it from admin's.
- [x] **Step 4:** Delete the old route directory, one file per `git rm` call (the repo's fact-forcing gate blocks `git rm -r`).
- [x] **Step 5:** `npm test && node ../scripts/check-structure.mjs` — green.
- [x] **Step 6: Commit.**

---

## Task 4: Three registries → Connections (as an admin-gated section)

**DONE — `27ece961`** (2026-10-30), with **Step 4 half-done on purpose**.

* Steps 1–3 and 5–8 as written. Connections keeps its `minRole`: **the tab is NOT
  admin-only**, only the new "Tenant connectors" block inside it is. The three pages stay
  at their `/platform/*` routes and are linked from that block.
* **Step 4 deviation:** the `kind: 'api'` rows were dropped, but the OS's own MCP endpoint
  was **not** surfaced elsewhere — the My MCP access page already lists it, so there was
  nothing to add. The per-app endpoint on the Software page was likewise already present.

**Files:** create `os-ui/tabs/connections/lib/registries.ts` + test, `os-ui/tabs/connections/ui/AdminRegistries.tsx`; modify the Connections page, `os-ui/core/kernel/tabs.ts`; modify `os-ui/tabs/admin/lib/mcp-registry.ts`

**Interfaces:**
- Consumes: nothing. The earlier dependency on Task 2 is GONE — it existed only because making the tab admin-only would have stranded per-user OAuth.
- Produces: `REGISTRIES: { id: 'mcp-apis' | 'oauth-apps' | 'plugins'; label: string; href: string }[]`, all `minRole: 'admin'`.

- [x] **Step 1: Write the failing tests.**

```ts
test('REGISTRIES: all three are admin-only', () => {
  assert.equal(REGISTRIES.length, 3);
  for (const r of REGISTRIES) assert.equal(r.minRole, 'admin');
});

test('MCP-REGISTRY: lists only what an admin added, not the OS own endpoints', () => {
  // kind:'api' rows were OS surface area, never trust decisions.
  assert.equal(registryEntries().some((e) => e.kind === 'api'), false);
});
```

- [x] **Step 2: Run them.** Expect both to fail.
- [x] **Step 3: Add `registries.ts` and `AdminRegistries.tsx`**, rendered as a clearly separated admin-only block on the Connections page, not mixed into a user's own connection list.
- [x] **Step 4: Drop the `kind: 'api'` rows** from `mcp-registry.ts`. Surface the OS's own MCP endpoint on the My MCP access page instead, and an app's own endpoint on its Software page.
- [x] **Step 5: Do NOT change the Connections tab's `minRole`.** It stays creator-visible by the user's decision. Only the registries block is admin-gated, via `roleAtLeast(role, 'admin')` around it.
- [x] **Step 6: Verify per-user OAuth still works.** `cd os-ui && npm test -- --grep "drive-oauth"` must stay green. The earlier hard stop no longer applies, since the tab keeps creator access.
- [x] **Step 7:** Full suite + structure check.
- [x] **Step 8: Commit.**

---

## Task 5: Roles & Permissions and Security & Egress → Governance

**DONE — `979b7acc`** (2026-10-30). Both surfaces are now Governance tabs, admin-gated
inside Governance because Governance is builder-visible.

* **Step 3 deviation:** there was no roles lib to move. The role matrix already lived in
  `core/policy/role-config`, so `tabs/governance/lib/roles.ts` is a NEW file holding the
  governance-side vocabulary and projection over kernel state, not a `git mv`.
  `tabs/governance/lib/egress.ts` was moved as written.
* Step 4's cross-link exists both ways: Users & Access → Governance roles, and back.

**Files:** create `os-ui/tabs/governance/lib/roles.ts` + test; modify the Governance page, `os-ui/app/(govern)/platform/access/` to cross-link, and delete `os-ui/app/(govern)/platform/roles/`

- [x] **Step 1: Write the failing test** asserting role definitions are readable from `@tabs/governance/lib/roles` and that each role's permission list is non-empty.
- [x] **Step 2: Run it.** Fails on the missing module.
- [x] **Step 3: Move the whole roles surface** into `tabs/governance/lib/roles.ts` and the egress/security surface into `tabs/governance/lib/egress.ts`. Both become Governance tabs. Assigning a person a role stays in Platform's Users & Access.
- [x] **Step 4: Add the cross-link** from Users & Access to the Governance role page, and back. This is the workflow cost of the split, so it must be one click each way.
- [x] **Step 5:** Delete the old route, one `git rm` per file.
- [x] **Step 6:** Suite + structure check.
- [x] **Step 7: Commit.**

---

## Task 6: Documentation and loose ends

**DONE** (2026-10-30). Step 2 is written the OTHER WAY ROUND from the plan: Connections is
**not** admin-only — the user settled that on 2026-10-30 (see the decision table above), so
the CHANGELOG records that creators still see their own connections and corrects the earlier
intention, which the branch's commits could otherwise be read as having implemented.
Step 4 stops at the commit: pushing and opening the PR is the user's call.

Three stale comments were found and fixed while writing this up, beyond Step 0's label:
`core/kernel/tabs.ts` still said the personal surfaces were sections of the admin menu, and
still described Platform as rendering "ONLY the tiles a builder is authorised for" with a
"self-service Settings tile" — both untrue since Tasks 2 and 7.

- [x] **Step 0: Fix the stale label in `os-ui/tabs/admin/manifest.ts`.** It still reads `nav: { label: 'Admin', … }`. Nothing consumes manifest `nav` (the sidebar reads `core/kernel/tabs.ts`), so it is dead metadata — but it now contradicts the live label. Found during Task 1 and deliberately left alone there. **Done; `routes` needed no change** — it lists route PREFIXES, so `/platform` already covers the redirect stubs and the three registry pages. The reasoning is now written into the manifest header.

### Documentation

- [x] **Step 1:** Update `os-ui/ARCHITECTURE.md`'s tab table and add a short note on the rule used here: a surface belongs to the tab that answers the question the user is asking, and observation separates from configuration. **Done** — a "Which tab owns a surface" section with four rules: the question asked, observation vs configuration, policy vs administration, and "a surface moving to a lower `minRole` carries its own gate".
- [x] **Step 2:** `CHANGELOG.md` entry under Unreleased, ~~including the breaking change that **Connections is now admin-only**~~ — **inverted**: Connections is NOT admin-only, creators keep their own connections, and only the "Tenant connectors" block is admin-gated. The entry also lists where all ten surfaces went and records the route→tab gate move.
- [x] **Step 3:** `node scripts/build-docs.mjs` then `--check`.
- [x] **Step 4: Commit.** ~~push, open the PR. Merge with Rebase and merge, never squash~~ — **not done, deliberately**: the user decides when to publish. When it is published, rebase and merge, never squash — squashing recreated a history divergence twice in this repo.

---

## Task 7: Platform adopts the Governance look — one route, tabs on top

**DONE — `ca898d4e`** (2026-10-30). One route, a `.tabstrip`, **the tile grid is gone**, and
Overview absorbed Components & System as "Overview & Health" — builder-readable with
admin-only actions. The role gate moved out of the route's pathname check into per-tab
gating (`visibleSections`, `resolveSection`, `sectionMinRole` in `sections.ts`), all
fail-closed.

Two deviations:

* **Step 5:** the layout's deep-path bounce was **kept**, not removed — three admin pages
  (`/platform/{mcp-apis,oauth-apps,plugins}`) still live under `/platform` and still need it.
* **Per-section page titles are gone** by nature of the pattern: one route carries one
  `PageHeader` ("Platform"), exactly as Governance does. Not a regression, but the old
  per-page titles do not come back.

**This is not the strip we deleted.** On 2026-10-28 Platform had a navigation
strip *and* a tile grid: two navigation systems for one page, which is why the
strip went. Governance's pattern is **one** system — a `.tabstrip` that switches
content in place on a single route. Adopting it means the **tile grid goes away**,
not that the strip comes back.

**Files:** modify `os-ui/app/(govern)/platform/page.tsx`; create
`os-ui/tabs/admin/ui/<Section>.tsx` per section; add redirects for the old routes

**Reference:** `os-ui/app/(govern)/governance/page.tsx` — a `.tabstrip` plus one
component per tab (`ApprovalsInbox`, `PoliciesView`, `AuditLog`, `CostLimits`),
with `?focus=` deep-link support.

**Interfaces:**
- Consumes: `ADMIN_SECTIONS` and `ADMIN_GROUP_ORDER` from Task 1.
- Produces: `/platform?section=<id>`, the deep-link shape every old route redirects to.

**One tab per section, six tabs, not one tab per group.** (Earlier drafts of this plan said eight; six is the settled number.) Each Platform
section is a full working surface — a users table, a domains table, a backups
runner. Stacking four of those under a "Tenant" tab produces a page nobody can
scan. Governance's tabs are each one working surface, and being faithful to that
means eight tabs. Render the strip in `ADMIN_GROUP_ORDER` sequence so related
tabs sit together.

- [x] **Step 1: Write the failing test** in `sections.test.ts`:

```ts
test('PLATFORM: every section is reachable as a tab on one route', () => {
  for (const s of ADMIN_SECTIONS) {
    assert.equal(s.href, `/platform?section=${s.id}`, `${s.id} still points at its own route`);
  }
});
```

- [x] **Step 2: Run it.** Fails: hrefs are still `/platform/<id>`.
- [x] **Step 3: Move each page's body into a component** under `tabs/admin/ui/`, one per section, importing the lib it already uses. Pure move; no behaviour change.
- [x] **Step 4: Rewrite `platform/page.tsx`** as a `.tabstrip` plus the active component, mirroring the Governance page. Read the active tab from `?section=`, defaulting to `overview`. Filter tabs by `roleAtLeast` so a builder sees only Overview.
- [x] **Step 5: Keep the old links working.** Each `app/(govern)/platform/<id>/page.tsx` becomes a redirect to `/platform?section=<id>`. Code and docs reference these paths (for example "set prices in Platform → Models"), so removing them outright would 404 live links.
- [x] **Step 6: Phone width.** Six tabs will not fit at ~400px: put the strip in an `overflow-x: auto` container so it scrolls rather than wrapping into a block that pushes the content down a screen.
- [x] **Step 7:** Full suite, structure check, and check `/platform` plus two redirects by hand.
- [x] **Step 8: Commit.**

---

## Open question for the user


**Does a creator still need to see their own connections at all?** This plan assumes yes, surfaced at the point of use in Files and Knowledge plus the account menu. If the answer is no, and only admins ever connect anything, Task 4 simplifies a lot: the per-user OAuth path can be reached from the account menu only, and Files/Knowledge source pickers list what the tenant already connected. Confirm before starting Task 4.
