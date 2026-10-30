# Admin → Platform restructure: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Admin stops being the place things land when nobody knows where they go. Seventeen sections become nine, each remaining one genuinely tenant administration, with **no new top-level tabs**.

**Architecture:** `tabs/admin/lib/sections.ts` is already the single source of truth for the menu, and `/platform` renders it as a grouped tile grid. So most of this is moving entries between owners and giving three arrivals a home, not rebuilding navigation.

**Tech stack:** Next.js app router, `os-ui/core/kernel/tabs.ts` for the nav, `os-ui/tabs/<tab>/lib|ui` per tab, role gates via `roleAtLeast`.

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
| Connections becomes admin-only | A connection then means one thing: the tenant's trust boundary. Possible **only** because personal linking moves to the account menu — see the constraint above. |
| OS-published MCP endpoints leave the registry | `tabs/admin/lib/mcp-registry.ts` carries `kind: 'api'` rows pointing at the OS's own endpoints (`/api/gateway` among them). Those were never trust decisions; listing them buries the few third-party servers an admin actually vouched for. |
| Security & Egress stays in Platform **for now** | The egress allowlist is simultaneously policy (argues Governance) and connector config (argues Connections). Revisit once the rest has moved and it is clear which it reads as. |

**Target Platform, nine sections in three groups**

- **Tenant** — Overview, Domains, Tenant Settings, Users & Access
- **Models** — LLM Gateway, Models & Providers
- **Infrastructure** — Components & System, Backups & Restore, Security & Egress

---

## File structure

| File | Responsibility after this plan |
|---|---|
| `os-ui/tabs/admin/lib/sections.ts` | Nine Platform sections, three groups. Loses seven entries. |
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

**Files:** modify `os-ui/core/kernel/tabs.ts`, `os-ui/tabs/admin/lib/sections.ts`, `os-ui/tabs/admin/lib/sections.test.ts`

**Interfaces:**
- Produces: `ADMIN_GROUP_ORDER` becomes `['Tenant', 'Models', 'Infrastructure']`; later tasks rely on those exact strings.

- [ ] **Step 1: Write the failing test.** In `sections.test.ts`:

```ts
test('PLATFORM: holds only tenant administration', () => {
  const ids = ADMIN_SECTIONS.map((s) => s.id).sort();
  assert.deepEqual(ids, [
    'access', 'backups', 'components', 'domains', 'gateway',
    'models', 'overview', 'security', 'settings',
  ]);
});

test('PLATFORM: the moved surfaces are gone', () => {
  for (const gone of ['billing', 'roles', 'plugins', 'mcp-apis', 'oauth-apps', 'my-mcp', 'my-settings', 'licenses']) {
    assert.equal(ADMIN_SECTIONS.find((s) => s.id === gone), undefined, `${gone} still in Platform`);
  }
});

test('PLATFORM: three groups, in order', () => {
  assert.deepEqual([...ADMIN_GROUP_ORDER], ['Tenant', 'Models', 'Infrastructure']);
});
```

- [ ] **Step 2: Run it and watch it fail.** `cd os-ui && npm test 2>&1 | grep PLATFORM` — expect failures naming the eight surfaces still present.
- [ ] **Step 3: Delete the seven moved entries** from `ADMIN_SECTIONS` (keep `access`; it stays). Set `ADMIN_GROUP_ORDER` to the three groups and move `access` to group `'Tenant'`.
- [ ] **Step 4: Change the nav label.** In `core/kernel/tabs.ts`, `{ label: 'Admin', … }` → `{ label: 'Platform', … }`. Leave `href: '/platform'` and `feature: 'admin'` alone.
- [ ] **Step 5: Run the suite.** `npm test` — green, and `node ../scripts/check-structure.mjs` at baseline.
- [ ] **Step 6: Commit.** `git commit -m "refactor(platform): Admin becomes Platform, nine sections in three groups"`

---

## Task 2: Account menu for the three personal items

Do this task **before** Task 4. Connections cannot become admin-only until personal linking has a home.

**Files:** modify `os-ui/core/ui/Sidebar.tsx`; test `os-ui/core/ui/account-menu.test.ts` *(new)*

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `ACCOUNT_ITEMS: { id: string; label: string; href: string; minRole: Role }[]`, exported from `Sidebar.tsx`, consumed by its test only.

- [ ] **Step 1: Write the failing test.**

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

- [ ] **Step 2: Run it.** Expect "does not provide an export named 'ACCOUNT_ITEMS'".
- [ ] **Step 3: Add `ACCOUNT_ITEMS` and render it** in the sidebar's existing user area, role-filtered with `roleAtLeast`. Keep the routes unchanged so existing bookmarks work.
- [ ] **Step 4: Run tests.** Green.
- [ ] **Step 5: Commit.** `git commit -m "feat(ui): personal settings move to an account menu"`

---

## Task 3: Cost & Billing → Monitoring

**Files:** `git mv os-ui/tabs/admin/lib/billing.ts os-ui/tabs/monitoring/lib/spend.ts` (plus its test); modify `os-ui/tabs/monitoring/manifest.ts`, the Monitoring page, and delete `os-ui/app/(govern)/platform/billing/`

- [ ] **Step 1:** `git mv` the lib and its test, so history follows the file.
- [ ] **Step 2:** Update imports. `grep -rln "admin/lib/billing" os-ui | xargs sed -i '' 's#@tabs/admin/lib/billing#@tabs/monitoring/lib/spend#g'`
- [ ] **Step 3:** Render it as a Monitoring section; add `/api/platform-admin/billing` to Monitoring's manifest `api` list and drop it from admin's.
- [ ] **Step 4:** Delete the old route directory, one file per `git rm` call (the repo's fact-forcing gate blocks `git rm -r`).
- [ ] **Step 5:** `npm test && node ../scripts/check-structure.mjs` — green.
- [ ] **Step 6: Commit.**

---

## Task 4: Three registries → Connections, and Connections becomes admin-only

**Files:** create `os-ui/tabs/connections/lib/registries.ts` + test, `os-ui/tabs/connections/ui/AdminRegistries.tsx`; modify the Connections page, `os-ui/core/kernel/tabs.ts`; modify `os-ui/tabs/admin/lib/mcp-registry.ts`

**Interfaces:**
- Consumes: `ACCOUNT_ITEMS` must already exist (Task 2).
- Produces: `REGISTRIES: { id: 'mcp-apis' | 'oauth-apps' | 'plugins'; label: string; href: string }[]`, all `minRole: 'admin'`.

- [ ] **Step 1: Write the failing tests.**

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

- [ ] **Step 2: Run them.** Expect both to fail.
- [ ] **Step 3: Add `registries.ts` and `AdminRegistries.tsx`**, rendered as a clearly separated admin-only block on the Connections page, not mixed into a user's own connection list.
- [ ] **Step 4: Drop the `kind: 'api'` rows** from `mcp-registry.ts`. Surface the OS's own MCP endpoint on the My MCP access page instead, and an app's own endpoint on its Software page.
- [ ] **Step 5: Make the Connections tab admin-only.** In `core/kernel/tabs.ts` set the connections entry `minRole: 'admin'`.
- [ ] **Step 6: Verify nothing broke per-user OAuth.** `cd os-ui && npm test -- --grep "drive-oauth"` must stay green, and manually confirm Files and Knowledge still offer a source-connect path through the account menu, not through the now-admin Connections tab. **If they do not, stop:** the admin-only flip is wrong until they do.
- [ ] **Step 7:** Full suite + structure check.
- [ ] **Step 8: Commit.**

---

## Task 5: Role definitions → Governance

**Files:** create `os-ui/tabs/governance/lib/roles.ts` + test; modify the Governance page, `os-ui/app/(govern)/platform/access/` to cross-link, and delete `os-ui/app/(govern)/platform/roles/`

- [ ] **Step 1: Write the failing test** asserting role definitions are readable from `@tabs/governance/lib/roles` and that each role's permission list is non-empty.
- [ ] **Step 2: Run it.** Fails on the missing module.
- [ ] **Step 3: Move the definition logic** from the admin roles lib into `tabs/governance/lib/roles.ts`. Leave assignment in Users & Access.
- [ ] **Step 4: Add the cross-link** from Users & Access to the Governance role page, and back. This is the workflow cost of the split, so it must be one click each way.
- [ ] **Step 5:** Delete the old route, one `git rm` per file.
- [ ] **Step 6:** Suite + structure check.
- [ ] **Step 7: Commit.**

---

## Task 6: Documentation

- [ ] **Step 1:** Update `os-ui/ARCHITECTURE.md`'s tab table and add a short note on the rule used here: a surface belongs to the tab that answers the question the user is asking, and observation separates from configuration.
- [ ] **Step 2:** `CHANGELOG.md` entry under Unreleased, including the breaking change that **Connections is now admin-only** and where personal account linking moved.
- [ ] **Step 3:** `node scripts/build-docs.mjs` then `--check`.
- [ ] **Step 4: Commit, push, open the PR. Merge with Rebase and merge, never squash** — squashing recreated a history divergence twice in this repo.

---

## Open question for the user

**Does a creator still need to see their own connections at all?** This plan assumes yes, surfaced at the point of use in Files and Knowledge plus the account menu. If the answer is no, and only admins ever connect anything, Task 4 simplifies a lot: the per-user OAuth path can be reached from the account menu only, and Files/Knowledge source pickers list what the tenant already connected. Confirm before starting Task 4.
