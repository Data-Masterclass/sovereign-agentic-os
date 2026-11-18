# Files bulk Promote tells the user why — and offers the fix in the same toolbar

**Filed:** 2026-11-18 · **Branch:** `fix/files-bulk-promotion` (from `public/main`
`e27661c9`) · **Phases:** PLAN → DESIGN → IMPLEMENT (test-first) → TEST, one commit each.

## 1. The defect, as verified on this head

The owner selected 12 PDFs in `/Invoices`, pressed the bulk **Promote to Domain →** and read:

> `0 requested · 1 failed. A domain admin approves each.`

Two separate lies in one line: nothing says *why*, and the sentence about a domain admin
describes an approval that was never filed.

`tabs/files/ui/FilesBrowser.tsx:358` `bulkPromote`:

```ts
const res = await fetch(`/api/files/${f.id}/promote`, { method: 'POST', … });
if (res.ok) requested += 1; else failed += 1;
…
setBulkNotice(`${requested} requested${failed ? ` · ${failed} failed` : ''}…. A domain admin approves each.`);
```

The response **body is never read**. The server is not silent — `tabs/files/lib/store.ts`
`requestPromotion` runs the gate and fails with an exact message:

```ts
const gate = promotionGate(a);
if (!gate.ok) fail(`Cannot promote — ${gateReason(gate)}.`, 400);
```

and `tabs/files/lib/promotion.ts` names every gap (`owner`, `domain`, `a description`,
`at least one tag`). For the owner's 12 invoices the body was
`Cannot promote — add a description, at least one tag first.` — a 400 that reached the browser,
was parsed by nobody, and was discarded by `res.ok`.

**The gate is correct and stays.** It is the same documentation minimum the Data tab enforces
(locked decision #5: owner + description + ≥1 tag); nothing undocumented enters the shared
store. The defect is the UI: it threw the diagnosis away
(ARCHITECTURE.md → *"Diagnostics are a feature, and discarding them costs hours"*).

The single-file path does **not** have this bug — `FilePreview.tsx:181` already shows
`data.error`. So the owner's one-file flow explained itself and the bulk flow did not, which is
how 12 files reported "1 failed".

### The admin question, settled

Promoting one's own file **as an admin** is the intended flow, not a bug: the owner proposes,
a domain admin approves (`approverRole: 'domain_admin'`, `app/api/files/[id]/promote/route.ts`).
Being signed in as admin does not skip the documentation gate, and this change does not touch
governance. It only makes the gate — and the outcome — visible.

## 2. What ships

1. **Per-file results.** Bulk Promote reads `(await res.json()).error` for every failure and
   reports successes plus each distinct reason, collapsed: `12 files: add a description, at
   least one tag first`. When zero were requested the notice does not mention a domain admin.
2. **Pre-flight in the toolbar.** The listing already carries `tags`; it does **not** carry
   `description` (checked: `FileSummary`, `store.ts:84`), so the summary gains that one field.
   The toolbar then reads `3 of 12 ready to promote`, and Promote is disabled with a hint when
   none are.
3. **"Describe & tag" bulk action.** One description + a tag list applied to every selected
   file the user can manage, through the **existing** per-file write path — `PATCH
   /api/files/[id]` → `setDocs` (edit-gated via `editOf`). Tags are a set-union (append, not
   replace) unless the user explicitly clears; the description is written only where one is
   missing unless **Overwrite existing descriptions** is ticked. Same per-file reporting.
4. **One formatter, both paths.** `FilePreview`'s single-file error and the bulk notice read
   the server's text through the same helper in `tabs/files/lib/`.

## 3. Tests

| Test | Asserts |
|---|---|
| `bulk-result.test.ts` | identical reasons collapse to `N files: <reason>`; zero-requested wording drops the approval sentence; `serverError` prefers the body's `error` |
| `promotion.test.ts` (extended) | `promotionReadiness` over listing rows — the SAME `promotionGate`, counted |
| `bulk-docs.test.ts` | describe-and-tag: union keeps existing tags, replace clears, description only where empty unless overwrite, no-op → no request |
| `bulk-promote-tripwire.test.ts` | `FilesBrowser.tsx` read as TEXT (a test cannot import a `.tsx`): `bulkPromote` reads the JSON body and routes it through `serverError`, and no `if (res.ok)`-only branch survives; `FilePreview.tsx` shares the helper |

## 4. Constraints honoured

- A tab imports only `@core/*` and itself; `core/` gains nothing.
- New files carry `FEATURE` / `USER STORY` / `ARCHITECTURE` + SPDX headers.
- No TS enums, no parameter properties; no test imports a `.tsx` or a `route.ts`.
- No new write path: the bulk docs edit reuses `PATCH /api/files/[id]`, whose gate is
  `setDocs` → `editOf` → `canManageArtifact` — identical to the single-file editor.
- `node scripts/check-structure.mjs` must not rise above 419 / 1 / 200 / 1230.

---

## 5. Design (DESIGN phase, 2026-11-18)

### 5.1 File list

| File | Change |
|---|---|
| `os-ui/tabs/files/lib/bulk-result.ts` | **new** — the shared result formatter (`serverError`, `shortReason`, `summariseBulk`) |
| `os-ui/tabs/files/lib/bulk-docs.ts` | **new** — pure describe-and-tag semantics (`unionTags`, `describeAndTagPatch`) |
| `os-ui/tabs/files/lib/promotion.ts` | widen `promotionGate` to the gate FIELDS; add `promotionReadiness` |
| `os-ui/tabs/files/lib/store.ts` | `FileSummary` gains `description`; `summarise()` carries it |
| `os-ui/tabs/files/ui/FilesBrowser.tsx` | per-file bulk results, pre-flight toolbar, the Describe & tag dialog |
| `os-ui/tabs/files/ui/FilePreview.tsx` | single-file promote error reads through `serverError` |
| `bulk-result.test.ts`, `bulk-docs.test.ts`, `bulk-promote-tripwire.test.ts`, `promotion.test.ts` | the four tests in §3 |

### 5.2 One gate, three readers

`promotionGate` takes only what it reads, so the **listing row** and the **stored asset** pass
through the identical function — no second copy of the rule in the browser:

```ts
export type GateFields = Pick<FileAsset, 'owner' | 'domain' | 'description' | 'tags'>;
export function promotionGate(a: GateFields): GateResult;        // unchanged body
export function promotionReadiness(rows: GateFields[]): { ready: number; total: number; blocked: GateResult[] };
```

`FileSummary` is the only shape change in the API: one `description: string` field. The browser
needs it because the gate needs it, and inventing a client-side approximation of "documented"
is precisely the drift this codebase punishes.

### 5.3 The notice grammar

```ts
export type BulkOutcome = { id: string; name: string; ok: boolean; error?: string };
export function serverError(body: unknown, fallback: string): string;   // body.error ?? fallback
export function shortReason(text: string): string;                      // drop "Cannot promote — " + trailing "."
export function summariseBulk(
  outcomes: BulkOutcome[],
  opts: { verb: string; skipped?: number; approvalNote?: string },
): BulkSummary;  // { ok, failed, skipped, reasons: {reason,count,names}[], notice }
```

- `ok > 0` → `3 requested`; `ok === 0` → `Nothing requested`.
- `· N failed`, `· N skipped` only when non-zero.
- `approvalNote` ("A domain admin approves each.") is appended **only when `ok > 0`** — that is
  the half of the bug that lied about governance.
- One line per distinct `shortReason`, commonest first: `12 files: add a description, at least
  one tag first`; a single casualty is named instead (`invoice-01.pdf: …`), because with one
  file the name is the more useful fact.

### 5.4 Describe & tag — semantics, and why no new write path

The dialog collects `{ description, tags, overwriteDescription, replaceTags }`, and
`describeAndTagPatch(row, input)` returns the PATCH body for one file, or `null` when the file
would not change (skipped, never "failed"):

- **tags** — `replaceTags ? entered : unionTags(row.tags, entered)`. The union keeps existing
  order and existing casing, dedupes case-insensitively, and is omitted when it equals
  `row.tags`. Append is the default because a bulk retag that silently dropped the tags a file
  already carried would destroy work on a mis-click.
- **description** — written when the entry is non-empty **and** (`overwriteDescription` or the
  row's description is blank). Default is fill-the-gaps.
- Both omitted → `null`.

The request is `PATCH /api/files/[id]` with that body, the route the single-file editor already
uses; it maps to `setDocs`, whose gate is `editOf` → `canManageArtifact`. **No new write path,
so there is no second gate to keep in step.** The UI additionally filters the selection through
the same `canManageFile` predicate the other bulk actions use, so nothing is attempted that the
user could not do one-by-one.

### 5.5 Deliberately not in scope

- Governance is untouched: `approverRole: 'domain_admin'`, the owner-proposes handoff, and
  `applyApprovedFilePromotion` are unchanged. An admin promoting their own file still files a
  request and still approves it in Governance — the intended flow.
- The gate itself is unchanged. The fix is visibility, not permissiveness.
- No bulk MCP twin: the per-file file write tools already exist, and a bulk wrapper is a
  separate decision.

---

## 6. Outcome (TEST phase, 2026-11-18)

### 6.1 What the owner now reads

The same selection of 12 undocumented invoices, before anything is POSTed:

> `12 selected` · Promote to Domain → *(disabled)* · `0 of 12 ready to promote` ·
> `Add a description, at least one tag first — “Describe & tag” does it for the selection.`

And if the request is filed anyway (some ready, some not):

> `3 requested · 9 failed. A domain admin approves each. 9 files: add a description, at least
> one tag first.`

With none ready, the governance sentence is gone:

> `Nothing requested · 12 failed. 12 files: add a description, at least one tag first.`

### 6.2 Gates

| Gate | Result |
|---|---|
| `os-ui/node_modules/.bin/tsc --noEmit -p os-ui` | clean |
| Targeted: `bulk-result` / `bulk-docs` / `promotion` / `bulk-promote-tripwire` | 24 tests, 24 pass |
| Files tab: `tabs/files/**/*.test.ts` | 183 tests, 183 pass |
| Full suite (`core/**` + `tabs/**`) | 6469 tests · 6465 pass · 0 fail · 4 todo (pre-existing `os-tools` Phase-2 todos) |
| `bash os-ui/scripts/gate.sh` | exit 0 — 436 tests, 432 pass, 0 fail, 4 todo |
| `node scripts/check-structure.mjs` | ok — 419 / 1 / 200 / 1230, unchanged by this branch |

### 6.3 Deviations from the design

- The tripwire's two "forbidden string" assertions (`if (res.ok)`, `res.ok ? `) were replaced
  with the STRUCTURAL invariant they were groping at: inside `bulkPromote`, `res.json()` must
  appear **before** `res.ok`. A whitespace change could have satisfied the string ban while
  leaving the defect; "parse before you judge" cannot be satisfied by formatting. Likewise the
  "the component must not reimplement the gate" negative was narrowed to `missing.push(` and
  paired with a positive assertion that `promotionReadiness(` is called — the first version
  matched the dialog's own empty-form check and failed for the wrong reason.
- `FileSummary` also had to be filled in at one more place: the search-hit fallback summary in
  `FilesBrowser` (`description: ''`), which synthesises a row for a hit not in the loaded list.

### 6.4 Left open

- The `files` listing now carries every file's description to the browser. That is the same
  text the preview already fetches per file and is covered by the identical DLS read gate
  (`canView` → `listFiles`), so no new material is exposed — but the payload grows with
  description length. If a drive of long descriptions ever makes the list heavy, the fix is a
  gate-only projection (`documented: boolean`), not dropping the pre-flight.
- "Describe & tag" writes the same description to every selected file. That is the point for a
  folder of invoices and wrong for a mixed selection; the per-file editor remains the place to
  differentiate, and the overwrite guard (off by default) is what keeps a mixed selection from
  losing its existing text.

---

## 7. Review round (PR #59, 2026-11-18) — MERGE with follow-ups

The review verdict was **merge**, with follow-ups of the same class as the original defect:
*a count is not a reason*. The fix had corrected it in `bulkPromote` only, and the same shape
survived three more places in the very same file. Closed here in one commit, test-first.

### M1 — a 200 that filed nothing was counted as a request

`app/api/files/[id]/promote/route.ts` answers a file whose request is still pending with
**200 `{ approval, already: true }`**. `bulkPromote` read only `res.ok`, so pressing Promote a
second time on twelve pending files reported **"12 requested"** and filed nothing — a count
standing in for a state, one layer along from the original bug.

`BulkOutcome` gains `already?: boolean` and `summariseBulk` gives it its **own clause**:

```
Nothing requested · 12 already pending.
1 requested · 9 already pending · 2 failed. A domain admin approves each.
```

The approval sentence is governed by `ok` alone — what **this press** filed — so a selection
that was already pending no longer claims to have created work for an admin.

### M2 — the other two bulk actions had the identical defect

- `bulkArchive` tallied `res.ok` exactly as Promote had.
- The **bulk move** was worse than a tally: every failure went into the one `setErr` strip, so
  moving twelve files and being refused on eleven displayed the twelfth's reason and lost the
  other ten. *Last writer wins* is the same defect wearing different clothes.

Both now build `BulkOutcome[]` and report through `summariseBulk` with verbs `archived` and
`moved`. The tripwire no longer tests one function: it iterates **all four** bulk actions
(`bulkPromote`, `bulkDescribeAndTag`, `bulkArchive`, `moveInto`) and asserts for each that the
body is parsed before `res.ok` is consulted, that the text reaches `serverError`, that the
notice comes from `summariseBulk`, that no `<verb> += 1` tally decides the outcome, and that no
per-file failure is written into a shared error strip. A fifth bulk action must join that list.

### L2 — the two hand-written notices

"Nothing to promote — N not promotable." and its archive twin were the last two notices built
by hand; both now go through `summariseBulk([], { verb, skipped })`, and a new tripwire asserts
that **every** `setBulkNotice(…)` call in the file is fed by the formatter (or clears it).

### L1 — the dialog says which tiers it will relabel

`tierBreakdown` (in `bulk-docs.ts`, unit-tested) renders the selection as
**"3 personal · 9 domain"** in the Describe & tag header, so a domain admin can see that the
action also rewrites files that are *already shared* — before pressing Apply.

### Gates after the follow-up commit

`tsc --noEmit -p os-ui` clean · Files tab **191 tests, 191 pass, 0 fail** ·
`check-structure` ok, 419 / 1 / 200 / 1230 unchanged. The full suite was not re-run for this
commit (nothing outside `tabs/files/**` changed, and the machine is memory-constrained).

### Deferred, with the reason

- **M3 — the describe-and-tag write is serial, uncapped and unconditional.** Each `PATCH`
  re-embeds the file (`reindexById` in the route — "the editor pays for the re-embed"), so a
  200-file selection is 200 sequential gateway round-trips with no progress beyond a spinner,
  no cap on the selection size, and no version precondition: two admins describing the same
  selection concurrently last-write-wins, with no sha to check. The right fix is the shape
  ARCHITECTURE.md already prescribes for queued writes — a reducer applied to the document the
  store just returned, committed with *that read's* token, through a bounded queue with
  per-file progress. That is a store-and-route change, not a notice change, and it does not
  belong in a commit about reporting.
- **L3 — tag dedupe is client-side only.** `cleanTags` dedupes case-insensitively before the
  PATCH, but `setDocs` itself only trims and drops blanks, so "Finance" and "finance" can still
  coexist on a file written by any other door (MCP, an import). The dedupe belongs in the store
  next to the trim; doing it there changes stored data for every writer and wants its own
  migration note.
- **L4 — the tripwire's `callbackBody` is a text slice.** It keys on
  `const <name> = useCallback(` and the next `}, [`, which is sound for the four functions as
  written and would silently widen if one of them ever contained that sequence in a nested
  literal. A real fix parses, which means a parser dependency for a grep.
- **L5 — the pre-flight knows which rows will 400, and posts them anyway.** Promote sends every
  eligible file, including the ones `promotionReadiness` has already judged blocked, and lets
  the server refuse them. That is deliberate for now: the server is the only authority on the
  gate, and skipping client-side would make the UI's judgement load-bearing. If the request
  volume ever matters, the move is to send only the ready rows and report the rest as
  *skipped* with the pre-flight's own reason — which needs the two reason vocabularies
  (pre-flight `missing`, server `error`) unified first.

---

## 8. Interop with PR #61 (promotion audit) — three response shapes, three sentences

PR #61 (`public/fix/promotion-audit` @ `f47878f3`, merging after this branch) makes
`POST /api/files/[id]/promote` answer with **exactly one of three** header-documented shapes:

| Response | Meaning | Outcome flag |
|---|---|---|
| `{ requested: true, promoted: false, approval }` | a request was FILED | neither |
| `{ requested: true, already: true, approvalId }` | one was already open | `already` |
| `{ promoted: true, requested: false, approvalId, applied, asset }` | the owner-approver's **one shot** — self-approved, already in the domain | `promoted` |

A `domain_admin`/`admin` **owner** gets the third: `requestPromotion` still runs first (owner
check + the documentation gate), the approval is still **enqueued** so no audience move is
invisible to the Governance queue or the audit trail, and then `applyEffect` + `decide` close
it out in the same press.

Read as a bare 200 that would be a **third spelling of the original defect**: an admin
promoting twelve of their own files would read "12 requested · A domain admin approves each"
for twelve files that are *already shared*, with no admin left to wait for. So:

- `BulkOutcome` gains `promoted?: boolean`; `summariseBulk` counts `requested`, `promoted` and
  `already` **apart** (`promoted` tested first — it carries `requested: false`), `ok` becomes
  `requested + promoted`, and there is an `N promoted` clause.
- **The approval sentence is keyed on `requested`, never on success.** Promoted-only,
  already-only and promoted+already results never claim an approver is involved:
  `12 promoted.` · `2 promoted · 2 already pending.` · and with one real filing,
  `1 requested · 2 promoted · 3 already pending · 4 failed. A domain admin approves each.`
- `FilePreview.requestPromote` branches the same way: `✓ Promoted to the domain.` for the one
  shot, `⏳ Already proposed — awaiting a domain admin…` for the handle-only reply, and the
  existing OS-wide approval notification only when an `approval` object really came back.

The tripwire pins both branches, including that `data.promoted` is classified **before**
`data.already`. Gates: `tsc` clean · Files tab **196 tests, 196 pass** ·
`check-structure` 419 / 1 / 200 / 1230 unchanged.

Note for whoever merges second: this branch now reads a contract that only exists on #61's
branch. Until #61 lands, `data.promoted` is simply never `true` and every notice behaves as
before — the classification is additive, not conditional on the other branch.
