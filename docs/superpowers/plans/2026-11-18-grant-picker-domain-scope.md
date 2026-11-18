<!-- SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Borek Data Ventures UG -->

# Grant picker shows folders from every domain — narrow the feed to the system's domain

**Date:** 2026-11-18 · **Branch:** `fix/grant-picker-domain-scope` · **Status:** DONE (gates green)

## The report

> "I see folders that do not belong to a domain when I want to grant context."

Reproduced while editing an agent system homed in `agentic-leader-autumn-winter-2026-2027`:
the Grants & Routing / Choose-Context folder tree offered `/northpeak/invoices PDF`, a
**personal** Files folder that lives in `agentic-leader-q3-2026`.

## Verified cause

`app/api/agents/systems/[id]/grants/available/route.ts` builds the feed from

```
listDatasets(principal) · listWorkflows(principal) · listPersonalKnowledge(principal)
listFiles(principal)    · listMetrics(principal)   · listConnectionsForUser(user)
```

Those listers scope to **`principal.domains`** — i.e. *everything the caller can see across
all their domains*. `core/kernel/auth.ts` narrows `user.domains` to `[activeDomain]` only when
the sidebar switcher has an active domain; in **"All domains"** mode (the default for a
multi-domain admin, and the state the reporter was in) `domains` is all four memberships, so
every tier — My, Domain and Company — returns four domains' worth of artifacts.

`tabs/agents/lib/grant-folders.ts` `grantFolderNodes()` then synthesises a folder node from
**each item's own `folder` path**, so every one of those four domains' folders (plus the
caller's personal folders in each) lands in the tree. The route never consults the SYSTEM's
domain — `getSystem(id, principal).domain` is read for the 403/404 scope gate and then
discarded.

`app/api/context/available/route.ts` → `tabs/software/lib/available-context.ts`
(`availableContext` / `availableContextWithFolders`, used by the core ContextGrants picker and
by "Ask the OS") has the identical pattern: `principal.domains`, no target-domain narrowing.

By contrast `app/api/folders/route.ts` already does the right thing — it passes
`activeDomain` into `listFolders(user, tab, scope, { activeDomain })`, and
`core/folders/folder-store.ts` drops any row not stamped with it.

## What this is NOT

A presentation leak, not an authorisation leak. Every item in the feed is one the caller may
already see and grant: the lists are canView/DLS-scoped, so no other user's drafts and no
non-member domain ever appeared. The defect is that the picker offers a **wider** choice than
the system it is editing can sensibly use, which (a) makes the tree unreadable and (b) invites
an author to wire a cross-domain folder into an agent by accident.

## Required outcome → design

### 1. The agents grant feed narrows to the system's domain

The route resolves the target domain once — `const target = getSystem(id, principal).domain`
(the record field, authoritative; the yaml's `system.domain` is cosmetic per
`tabs/agents/lib/store.ts`) — and applies it per scope:

| scope | rule |
| --- | --- |
| `personal` | keep only items whose own `domain === target` (a domainless item is kept — an unassigned artifact shows everywhere today and an admin needs it to domain-move it) |
| `domain` | keep only items whose own `domain === target` (same domainless carve-out) |
| `marketplace` | **unchanged** — cross-domain discovery of a certified product is the Marketplace's business, and narrowing it would remove grants that work today |

Every list exposes the field the rule needs (verified against the stores, not the docs):

- `DatasetSummary.domain: string` (`tabs/data/lib/store.ts:95`)
- `FileSummary.domain: string` (`tabs/files/lib/store.ts:88`)
- `PersonalKnowledgeSummary` = `Omit<PersonalKnowledgeRecord,'md'>` → `domain: string`
- `WorkflowSummary` = `Omit<WorkflowRecord,'md'|'tacit'>` → `domain: string`
- `MetricSummary.domain?: string` — **optional**, set from the owning dataset
  (`domain: d.domain || undefined`), so absent means a domainless dataset → kept by the
  domainless carve-out. No separate lookup needed.
- `Connection.domain: string` (`tabs/connections/lib/schema.ts:198`) — narrowed too, for
  consistency; `Certified` connections map to `marketplace` and stay unchanged.
- `operating-manual` is **not** narrowed: those items are not domain-keyed artifacts but the
  three manual SCOPES `resolveManual(scope, principal).canView` already gates. Narrowing a
  scope by a domain string would be meaningless.

Folder nodes then derive from the **narrowed** items, so the implicit rail cannot re-introduce
another domain's folder. The explicit registry rows merged alongside them switch to
`listFolders(viewer, tab, scope, { activeDomain: target })` — the same argument
`/api/folders` passes, which is what makes the two surfaces agree.

### 2. The same narrowing for `availableContextWithFolders`

Ask the OS / ContextGrants run **in the active domain**, not against a system record, so the
target there is `user.activeDomain` — read exactly the way `/api/folders` reads it. When it is
`null` ("All domains" chosen deliberately, and the only state in which there is no domain
context at all) **behaviour is unchanged**: the feed stays the union over `user.domains`,
because there is no single domain to narrow to and silently picking `domains[0]` would hide
artifacts the user explicitly asked to see across domains. This is the documented limit of
this fix: in "All domains" the ContextGrants picker still spans domains by design.

`availableContext` (the itemless-folders variant, also the grounding list for the Software
assistant's grant suggestions) takes the same narrowing so the assistant cannot propose an
id the picker no longer offers.

### 3. Legacy out-of-domain folder grants still render, with a warning

A system saved before this change can hold a folder grant whose path lives in another domain.
Narrowing the tree would make that grant **invisible** while it is still live on
`system.yaml` — the picker would show a system granting less than it grants, and a tick-and-
save round trip in the UI (`applyFolderSelection` removes de-selected folder grants) would
silently DELETE it.

So the feed builder also takes the system's **existing** folder-grant paths and re-admits any
that the domain narrowing dropped, marked `outsideDomain: true`:

```ts
{ items, folders: [{ path, scope, outsideDomain?: true }] }
```

**Superseded by review round 1 — see below.** This paragraph originally claimed the re-admitted
node "renders ticked" in the tree. It does not: the narrowed feed gives that folder no items,
and `triState` renders an item-less folder as `'none'`. What actually ships: the flagged row is
kept OUT of the tree and rendered as a read-only chip with an `outside this domain` badge, and
`tabs/agents/lib/grant-apply.ts` protects it from the reconcile so no round trip can delete it.
Item grants the feed no longer lists get the same treatment — kept, and badged, because
`nameOf()` can only fall back to the raw id for them.

### 4. Governance is unchanged — this is presentation only

Stated explicitly because it is the thing a reviewer must not have to guess:

- No authorisation decision moves. **Corrected after review (L10):** an earlier draft of this
  section named `assertGrantsWithinAuthority` as the gate on agent grants. It is not. That
  function (`tabs/data/lib/store.ts:1694`, `tabs/files/lib/store.ts:842`) validates the grantee
  list of a dataset/file **promotion approval** — a different surface entirely. Said honestly,
  an agent grant is written by the edit-scoped `system.yaml` PUT
  (`app/api/agents/systems/[id]/files/route.ts` → `writeFile`, owner / in-domain domain_admin /
  admin, optimistic-concurrency on the sha) and **nothing validates the granted ids at write
  time**: a system.yaml may name any id its author can type.
- What makes that safe is that a grant is not an access decision. The gates are (a) the
  canView/DLS filter inside every lister, so the PICKER only ever offers what the caller can
  already see; and (b) execution: every granted tool call at build/run runs AS the acting
  principal, OPA-checked and row/document-level filtered, and
  `tabs/agents/lib/build/os-tools.ts`'s `ScopedItemsLoader` re-resolves each folder grant
  through the same owner-scoped lists. A grant on an id the runner cannot read yields nothing —
  it is a *pointer*, not a permission.
- `os-tools.ts` is deliberately **not** narrowed. A build/run resolution must stay a function
  of the runner's authority, not of a picker's current view; narrowing it would change what an
  existing system actually does at run time, which is a governance change and out of scope.
- Nothing is removed from any stored `system.yaml` by this change. A legacy cross-domain grant
  keeps working until a human removes it.

### 5. Tests

A route cannot be imported by a test (`next/headers` ⇒ `ERR_MODULE_NOT_FOUND`), so the feed
builder is extracted into **`tabs/agents/lib/grant-feed.ts`** and tested directly. It takes the
already-listed groups as inputs rather than importing the other tabs' stores — a tab imports
only `@core/*` and itself (CONTRIBUTING rule 2), and `tabs/agents` importing
`@tabs/data/lib/store` would raise the `TAB-ISOLATION` ratchet. The route stays the gatherer;
the pure narrowing + folder derivation is the part worth testing.

`tabs/agents/lib/grant-feed.test.ts` — 4-domain admin principal, fixtures in two domains
(`agentic-leader-autumn-winter-2026-2027` = the system's, `agentic-leader-q3-2026` = foreign):

1. only the system domain's personal items survive; the foreign personal file (the reported
   `/northpeak/invoices PDF`) is gone;
2. only the system domain's domain-scope items survive;
3. marketplace items still appear, both domains' included;
4. a domainless item still appears (the carve-out);
5. folder nodes derive from the narrowed items only — no foreign folder, no foreign ancestor;
6. an explicit registry row from the foreign domain does not appear;
7. a legacy folder grant pointing outside the system's domain **is still in `folders`**, is
   flagged `outsideDomain: true`, and is not dropped;
8. a source **tripwire** over `app/api/agents/systems/[id]/grants/available/route.ts` (read
   with `readFileSync`, never imported) asserting the route imports the builder and hands it
   the system's domain — so the narrowing cannot be quietly bypassed in the route later.

`tabs/agents/lib/grant-folders.test.ts` (existing behaviour of `grantFolderNodes`) must stay
green and unchanged — the narrowing happens before it, never inside it.

`tabs/software/lib/available-context-domain.test.ts` — the active-domain narrowing of
`availableContext`, including the documented "no active domain ⇒ unchanged" case.

## Files

| file | change |
| --- | --- |
| `os-ui/core/kernel/domain-scope.ts` | **new** — the pure `inDomainScope` / `narrowToDomainScope` predicate both tabs share |
| `os-ui/core/kernel/domain-scope.test.ts` | **new** — the predicate's rules incl. the null-target and domainless carve-outs |
| `os-ui/tabs/agents/lib/grant-feed.ts` | **new** — pure feed builder: domain narrowing, folder-node derivation (delegates to `grantFolderNodes`), legacy out-of-domain grant re-admission |
| `os-ui/tabs/agents/lib/grant-feed.test.ts` | **new** — the eight assertions above |
| `os-ui/app/api/agents/systems/[id]/grants/available/route.ts` | reads the system's domain, passes `activeDomain: target` to `listFolders`, delegates assembly to `grant-feed.ts` |
| `os-ui/tabs/agents/ui/GrantPickers.tsx` | `outsideDomain` on the folder-node type; "outside this domain" badge on such a folder chip |
| `os-ui/tabs/software/lib/available-context.ts` | narrow by `user.activeDomain` when set; unchanged when null |
| `os-ui/tabs/software/lib/available-context-domain.test.ts` | **new** |
| `os-ui/ARCHITECTURE.md` | one entry under "Things this codebase will punish you for" |

## Task B — "Where the results go" loses the typed output (same tab, same PR)

### The report

The owner filled Type / Name / Scope / Folder under **"Where the results go"**, moved to
another stage, came back, and found the fields empty — read as "the settings reset".

### Cause

`OutputsSection` (`tabs/agents/ui/SimpleBuilder.tsx:1588`, mounted from `DefineStep` at line
537) keeps `draftKind` / `draftName` / `draftScope` / `draftFolder` as **local component
state**. Nothing is persisted until `addRow()` → `addOutput(system, …)` → `onCommit`, and the
button that calls it is labelled `+ Add output` — which reads as "add another one", not as
"this is how your typing gets saved". Leaving the Define stage unmounts the component and the
draft dies silently. The same class of defect as the inspector guard in
`os-ui/ARCHITECTURE.md` ("an unsaved-changes guard belongs to whoever owns the selection").

### Fix — the UX, not the model

The persistence path is unchanged: `addOutput(system, …)` → `onCommit` → the governed
`system.yaml` write. Nothing new is stored, no new route, no governance change.

1. **Relabel** the button `+ Add output` → **`Save output`**. There is no edit-an-existing-row
   mode in this section (rows are added and removed only — `removeOutput(system, i)`), so no
   "Save changes" variant is introduced; adding one would mean inventing an edit mode the
   model does not have.
2. **Visible draft marker.** The draft row shows an `unsaved output` badge as soon as any
   field differs from the empty draft.
3. **Guard the exit.** `OutputsSection` reports `{ dirty, valid, save }` up (the knowledge
   editor's `onDirtyChange` shape — mirrored, **not** imported: a tab imports only `@core/*`
   and itself). `DefineStep` forwards it; `SimpleBuilder` owns every exit from the Define
   stage (`go`, `next`, and `StageShell`'s rail via `onState`) and therefore owns the prompt:
   - dirty **and valid** (name + folder present) → commit it, then navigate. The user's work
     lands; no question asked, because there is nothing to decide.
   - dirty and **invalid** → one shared confirm (`Save output` / `Discard` / `Keep editing`),
     with `Save output` disabled and a line saying the output still needs a name.
   One prompt in one place: putting it inside `OutputsSection` would guard neither the rail
   nor the "Grant context →" button, which is exactly the mistake the knowledge editor made.
4. **`tabs/agents/lib/output-draft.ts`** (new) — the pure part: the `OutputDraft` type,
   `EMPTY_OUTPUT_DRAFT`, `outputDraftDirty(draft)` (true when any field differs from the empty
   draft — including a lone Type or Scope flip, so the marker never under-reports) and
   `outputDraftValid(draft)` (trimmed name non-empty **and** a folder path present; `'/'`
   counts — root is a real destination).
5. **Tests** — `tabs/agents/lib/output-draft.test.ts`: dirty/clean for every field, valid vs
   invalid (blank name, whitespace name, blank folder), and a **source tripwire** over
   `SimpleBuilder.tsx` (read with `readFileSync`, never imported — a test cannot import a
   `.tsx`) asserting the label `+ Add output` is gone, `Save output` is present, and that the
   draft guard is wired (`outputDraftDirty` imported by the component).

### Files (task B)

| file | change |
| --- | --- |
| `os-ui/tabs/agents/lib/output-draft.ts` | **new** — `OutputDraft`, `EMPTY_OUTPUT_DRAFT`, `outputDraftDirty`, `outputDraftValid` |
| `os-ui/tabs/agents/lib/output-draft.test.ts` | **new** — the predicates + the label/wiring tripwire |
| `os-ui/tabs/agents/ui/SimpleBuilder.tsx` | one draft object, `Save output` label, `unsaved output` badge, `{dirty,valid,save}` reported up through `DefineStep`, the exit guard + prompt in `SimpleBuilder` |

## DESIGN — the contracts

### `core/kernel/domain-scope.ts` (new, pure, client-safe, imports nothing)

The predicate both surfaces share. It lives in the kernel because `tabs/agents` and
`tabs/software` both need it and a tab may not import another tab.

```ts
export type ScopeTier = 'personal' | 'domain' | 'marketplace';

/** True when an item belongs in a feed narrowed to `target`.
 *  `target === null` ⇒ no domain context: keep everything (today's behaviour).
 *  marketplace ⇒ always kept (cross-domain discovery is the Marketplace's job).
 *  a domainless item ⇒ always kept (unassigned artifacts show everywhere so an
 *  admin can still domain-move them). */
export function inDomainScope(
  item: { scope: ScopeTier; domain?: string | null },
  target: string | null,
): boolean;

/** `items.filter(i => inDomainScope(i, target))`, typed through. */
export function narrowToDomainScope<T extends { scope: ScopeTier; domain?: string | null }>(
  items: T[],
  target: string | null,
): T[];
```

### `tabs/agents/lib/grant-feed.ts` (new, pure)

```ts
/** What a lister contributes: the response shape PLUS the item's home domain. */
export type GrantFeedInput = {
  id: string; name: string; scope: ScopeTier;
  /** The artifact's own domain; absent/'' ⇒ unassigned. NOT returned on the wire. */
  domain?: string | null;
  layers?: ('bronze' | 'silver' | 'gold')[];
  folder?: string;
};
/** What the route returns per item (domain deliberately projected away). */
export type GrantFeedItem = { id: string; name: string; scope: ScopeTier; layers?: …; folder?: string };
export type GrantFeedFolder = {
  path: string; scope: 'personal' | 'domain';
  /** Set when this node exists ONLY because a live grant points at it from
   *  outside the system's domain — the picker renders it with a warning. */
  outsideDomain?: true;
};

export function buildGrantFeed(args: {
  /** The already-DLS-scoped items of ONE kind, each carrying its own domain. */
  items: GrantFeedInput[];
  /** The SYSTEM's domain — `getSystem(id, principal).domain`. */
  domain: string | null;
  /** Explicit registry rows, already read with `{ activeDomain: domain }`. */
  explicitFolders?: { path: string; scope: 'personal' | 'domain' }[];
  /** The folder grants LIVE on this system, so a legacy out-of-domain one is re-admitted. */
  grantedFolders?: { path: string; scope: 'personal' | 'domain' }[];
  /** Foldered kinds only: return `folders`. */
  withFolders?: boolean;
}): { items: GrantFeedItem[]; folders?: GrantFeedFolder[] };
```

Order inside `buildGrantFeed`: narrow items → derive nodes via the **existing**
`grantFolderNodes(explicit, narrowedItems)` (unchanged, still the only folder-node
derivation) → append any `grantedFolders` entry the result does not already contain,
flagged `outsideDomain: true`.

### The route (`app/api/agents/systems/[id]/grants/available/route.ts`)

```
const sys = getSystem(id, principal);          // scope gate (403/404) AND the target domain
… per-kind listers, each item mapped with `domain: <summary>.domain`
listFolders(viewer, tab, scope, { activeDomain: sys.domain })   // like /api/folders
buildGrantFeed({ items, domain: sys.domain, explicitFolders, grantedFolders, withFolders })
```

`grantedFolders` comes from `sys.system.grants[kind]` — each `ArtifactGrant.folder`
(`{ path, scope }`). `operating-manual` and `connection(s)` have no folders; the manual feed
is not narrowed at all (see above).

### `tabs/software/lib/available-context.ts`

`forKind` maps each row with its `domain` and filters through
`narrowToDomainScope(rows, user.activeDomain ?? null)`; `foldersForKind` passes
`{ activeDomain: user.activeDomain ?? null }` to `listFolders`. With no active domain both are
identity — the documented unchanged case.

### `tabs/agents/lib/output-draft.ts` (new, pure)

```ts
export type OutputDraft = {
  kind: 'files' | 'data' | 'knowledge';
  name: string;
  scope: 'personal' | 'domain';
  folder: string;
};
export const EMPTY_OUTPUT_DRAFT: OutputDraft; // { kind:'files', name:'', scope:'personal', folder:'/' }

/** Any field differs from the empty draft ⇒ the row shows "unsaved output". */
export function outputDraftDirty(draft: OutputDraft): boolean;
/** Committable: a trimmed name AND a folder path ('/' counts — root is a destination). */
export function outputDraftValid(draft: OutputDraft): boolean;
```


## TEST — what was actually run, and what it says

| gate | result |
| --- | --- |
| `os-ui/node_modules/.bin/tsc --noEmit -p os-ui` | clean |
| targeted: `domain-scope` · `grant-feed` · `output-draft` · `available-context-domain` · `grant-folders` · `grants-available` | 34 tests, 34 pass, 0 fail |
| full suite (`--test-concurrency=2`, `core/**` + `tabs/**`) | **6473 tests, 6469 pass, 0 fail, 4 todo**, exit 0 |
| `bash os-ui/scripts/gate.sh` | exit 0 — 436 tests, 432 pass, 0 fail, 4 todo (`check-worker-env` / `check-trino-rules-chart` SKIPPED: no subchart `.tgz` in this worktree) |
| `node scripts/check-structure.mjs` | TAB-ISOLATION 419 · LEGACY-IMPORT 1 · CORE-INDEPENDENCE 200 · FILE-HEADER 1230 — no new violations |

The 4 `todo` tests are the pre-existing `tabs/agents/lib/build/os-tools.test.ts` entries marked
`# fixed in Phase 2` (held-approval arguments, the layer pass-through). They were todo before
this branch and are untouched by it.

New tests added by this change: **24** (6 `domain-scope`, 11 `grant-feed` incl. the route
tripwire, 6 `output-draft` incl. the label tripwire, 3 `available-context-domain` incl. its
tripwire — the predicate assertions in that last file are counted once each).

### Deliberately NOT done

- `tabs/agents/lib/build/os-tools.ts` (the build/run folder-grant resolution) is unchanged — see
  §4. Narrowing it would change what an already-built system reads at run time.
- `availableContext*` in "All domains" still spans domains — see §2. No single target exists
  there, and guessing one would hide artifacts the user asked to see.
- The `grantable.ts` feed that grounds the Grant-stage ASSISTANT is unchanged: it offers names
  for a prompt, not a tree, and it already mirrors the route's per-kind logic by hand. Narrowing
  it is a sensible follow-up, not part of a presentation fix for the picker.
- Two other agents own `tabs/files/ui/*` and the promotion/approval paths; nothing there was
  touched.

## Review round 1 — what the independent review found, and what changed

The review BLOCKED the first version. Every finding was real; the headline two were the same
mistake in two tabs, and it was worse than the bug being fixed.

**H1 (block) — the narrowed feed made the agents picker DELETE out-of-domain grants on the
first tick.** Re-admitting the foreign folder NODE was not enough: the narrowed feed gives that
folder no items, `triState` (`core/kernel/folders.ts`) calls an item-less folder `'none'` so it
renders UNTICKED, and `computeSelection` (`core/ui/core/FolderTree.tsx`) skips folders with no
items — so the selection the tree emits omits it, and the old reconcile read that omission as a
de-selection and removed the grant. The same held for any ITEM grant whose id the narrowed feed
stopped listing, because item grants reconciled against the feed rather than against
`system.grants`. My "renders as ticked" claim in the code comment and in ARCHITECTURE.md was
simply false.

Fixed by moving the reconcile out of the component into **`tabs/agents/lib/grant-apply.ts`**
(so the round trip is testable at all) and bounding removal by what the tree could actually
show: `listedItemIds` (the feed's own ids) and `protectedFolders` (the out-of-domain nodes).
Pass neither and nothing is removed — an unknown universe must not authorise destruction. The
out-of-domain folders are now deliberately kept OUT of the tree (an item-less node can only
render as a lie) and shown below as read-only chips with the warning badge.

**H2 (block) — the identical deletion in the software context picker.** `reconcileGranted` kept
`current.filter(g => target.has(g.id))`, and the narrowed `availableContext` no longer lists an
out-of-domain grant, so any tick dropped it. Now `target.has(g.id) || !listed.has(g.id)`, with
`listed` = the ids the feed returned.

**M3 — raw NUL bytes.** Two files (my `grant-feed.ts` key builder, and the pre-existing
`tabs/connections/lib/warehouse/providers/snowflake.ts` control-char regex) contained literal
control bytes where the author meant the escapes `\0` / `\x00-\x1f`. Git treats such a file as
binary, so the review could not see the lines it had to judge. Both rewritten as escapes, plus
`core/kernel/source-text-tripwire.test.ts` over `core/ tabs/ app/ worker/`. Its docstring says
what it cannot see (bytes 0x0b-0x1f, and anything else that makes source unreadable).

**M4 — the guard's "Save output" could never enable:** it read validity from a ref, and a ref
does not re-render. `{dirty, valid}` are now mirrored into state (the callbacks stay in the
ref).

**M5 — the guard only covered the exits the builder owns.** Leaving the system entirely
(sidebar, another tab, a reload) unmounts the section with no transition to intercept — the
"it reset" as originally reported. The draft is now parked per system id in `sessionStorage`
(`outputDraftStorageKey` / `serializeOutputDraft` / `parseOutputDraft`, all pure and tested;
the component owns the try/catch, since storage is absent on the server and throws in a private
window) and restored on remount. Unmount stops REPORTING the draft; it no longer discards it.

**M6 — a predicate asymmetry that hid unassigned folders.** `inDomainScope` keeps a domainless
artifact; `listFolders`' own `activeDomain` option DROPS a row whose domain is empty. Passing
that option therefore made an unstamped folder vanish from the grant tree and the outputs
dropdown — and mislabelled it "outside this domain" if it was granted. Both feeds now read the
rows unnarrowed and filter them with `inDomainScope`. Two tripwires pin that `listFolders` is
never called with `activeDomain` there (asserted against the source with COMMENTS STRIPPED —
the first version of that assertion failed on its own explanatory prose).

**M7 — `/api/apps/by-slug/[slug]/context`** resolved display names through the now-narrowed
`availableContext`, so an app's out-of-domain grant rendered as a raw id on the very surface
that exists to be honest about what an app was granted. It resolves with
`{ ...user, activeDomain: null }`; it widens nothing (membership and canView unchanged) and only
ids already on `app.grants` are looked up.

**L8** `outputDraftValid` demanded non-blank folder text while `addOutput` normalises blank to
`'/'` — so a saveable draft was reported invalid, and the prompt it triggered had a Save button
that could never be pressed. Validity is now "a name", and `outputDraftFolder` exposes the same
normalisation the commit applies. **L9** `go`/`next` had lost the functional `setStage` form;
restored, with the guard probing where the transition would land. **L10** this plan and the
route header named `assertGrantsWithinAuthority` as the gate on agent grants — see §4, now
corrected: that function gates promotion-approval grantees, and an agent grant rides the
edit-scoped `system.yaml` PUT with no per-id validation at all.

### Files added or changed in this round

| file | change |
| --- | --- |
| `os-ui/tabs/agents/lib/grant-apply.ts` | **new** — the reconcile, lifted out of `GrantPickers.tsx`, with `listedItemIds` + `protectedFolders` bounding every removal |
| `os-ui/tabs/agents/lib/grant-apply.test.ts` | **new** — 8 tests incl. the full round trip (system in domain A, legacy grant in B, tick in A, B survives) |
| `os-ui/core/kernel/source-text-tripwire.test.ts` | **new** — no control byte below 0x09 in any source file |
| `os-ui/tabs/agents/ui/GrantPickers.tsx` | delegates to `grant-apply`; out-of-domain folders kept out of the tree and shown as badged chips; NUL removed |
| `os-ui/tabs/software/lib/grant-granularity.ts` + `.test.ts` | `reconcileGranted(…, listed)` keeps grants the feed no longer lists (+2 tests) |
| `os-ui/tabs/software/ui/SoftwareContextGrants.tsx` | passes `listed` |
| `os-ui/tabs/agents/lib/output-draft.ts` + `.test.ts` | L8 validity; the parking helpers (+3 tests) |
| `os-ui/tabs/agents/ui/SimpleBuilder.tsx` | M4 state mirror, M5 parking + restore, L9 functional `setStage` |
| `os-ui/tabs/software/lib/available-context.ts` | M6 folder rows via `inDomainScope` |
| `os-ui/app/api/agents/systems/[id]/grants/available/route.ts` | M6 (no `activeDomain` on `listFolders`), L10 header |
| `os-ui/app/api/apps/by-slug/[slug]/context/route.ts` | M7 |
| `os-ui/tabs/connections/lib/warehouse/providers/snowflake.ts` | M3 — pre-existing raw control bytes in a regex → escapes (semantics identical) |
| `os-ui/ARCHITECTURE.md` | the L10 correction + the "a narrowed feed is a narrowed diff" lesson |

## Review round 2 — merge, with five corrections

The re-review cleared the change and named five things, all applied in one commit.

1. **Marketplace item grants were still deleted by the first tick.** The reconcile was handed
   `listedItemIds: items.map(…)` — the WHOLE feed — while the tree only ever shows `treeItems`
   (personal + domain). Marketplace items are granted through the separate
   "+ Add from marketplace" picker, so they can never be unticked, and counting them as listed
   made their absence from the selection look like a de-selection. Now `treeItems.map(…)`, and
   the same one-word fix in `SoftwareContextGrants` (`treeItems`, not `items`), whose comment
   claimed the opposite. A marketplace-survives test in **both** test files.
2. **The out-of-domain folder chip's `AccessLevelSelect` was still live.** This picker cannot
   show what is inside a folder in another domain, so raising its capability would grant write
   over contents the author cannot inspect. `canEdit={canEdit && !isOutside(g.folder!)}`;
   removing the grant (✕) stays available, because that only ever reduces. Tripwired.
3. **Patch damage and stale comments.** A duplicated doc-comment opener at the top of
   `FolderResourcePicker`, and two comments still asserting the out-of-domain node "still
   renders ticked" — the claim round 1 disproved. Corrected here and in §3 above.
4. **Out-of-domain ITEM grants now carry the badge too.** They rendered as a bare id (that is
   all `nameOf()` has for an artifact the feed did not return) with a *scope* badge guessed at
   `'personal'`. The wording says only what is known: not in this view — usually another
   domain, possibly an artifact that is gone.
5. **`restoredFor` is keyed, not boolean.** The marker for "have I read this parking slot" is
   now the key itself, so handing the mounted section another system re-reads that system's
   slot (and resets to empty when it has none) instead of leaving the previous team's typing on
   screen and parking it under the new team's key.

## Guardrails for the execution

- Two other agents own `tabs/files/ui/*` and the promotion/approval paths — not touched here.
- `node scripts/check-structure.mjs` must not exceed 419 / 1 / 200 / 1230; both new files carry
  the SPDX + `FEATURE:` / `USER STORY:` / `ARCHITECTURE:` header.
- No TS enums, no parameter properties, no `.tsx`/`route.ts` imports from tests.
- Full suite runs **once**, with `--test-concurrency=2`; targeted files otherwise.
- No merge, no deploy.
