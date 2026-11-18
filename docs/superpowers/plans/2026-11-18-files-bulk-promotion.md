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
