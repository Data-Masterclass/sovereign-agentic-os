<!-- SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt) -->

# The admin re-index: pay down the Files and Knowledge index debt PR #56 could not undo

**Filed:** 2026-11-19 · **Branch:** `feat/reindex-corpus` (from `public/main` `7c45bd95`) ·
**Phases:** PLAN → DESIGN → IMPLEMENT (test-first) → TEST, one commit each.

## 1. The debt, and why it needs a tool

PR #56 made offline-mock a refusal in production (`core/kernel/offline-mock.ts`). It closed the
tap; it could not clean the tank. Three write paths had already run on a deployed cluster with
Docling, the ASR/OCR services or the embeddings gateway unreachable:

| Path | What landed in the index |
|---|---|
| `tabs/files/lib/ingest/live.ts` | **invented text** for a document the parser never read — placeholder sections, a placeholder transcript, a placeholder caption — then chunked, embedded and indexed |
| `tabs/files/lib/embed.ts` (`mockEmbed`) | **hash vectors** in `files`, `mode: 'mock'` |
| `tabs/knowledge/lib/embed.ts` (`hashEmbed`) | **hash vectors** in `knowledge`, `source: 'offline-hash'` |

`CHANGELOG.md` records the remedy as an UPGRADE ACTION: *re-index both indexes once the parsers
and the embeddings gateway are reachable.* Today that sentence is the whole tool — an operator
has no door to run it through. This branch builds the door.

### 1.1 What is, and is not, retroactively identifiable — the honest part

`IndexReport.embedSource` (`tabs/knowledge/lib/index-pipeline.ts:24`) and `EmbedResult.mode`
(`tabs/files/lib/embed.ts`) are **report** fields. Verified on this head: neither
`writeOpenSearch` (knowledge) nor `bulkIndex` (files) persists them. So:

> **A hash vector and a real vector are the same bytes in the same field. A fabricated row is
> indistinguishable from a real one once written.** No query finds them.

What a query *can* find — four kinds of evidence, all genuinely detectable:

1. **`marked`** — a row carrying an explicit stand-in string in a field that IS persisted:
   `source` / `embed_source` / `mode` ∈ {`offline-hash`, `mock`, `offline-mock`}. The
   `knowledge` index does persist a `source` keyword (`os-ui-ingest`, `files-use-as` — see
   `app/api/knowledge/docs/route.ts`, `tabs/files/lib/use-as.ts`), so the field exists and the
   query is meaningful even though today's expected count is **0**. We query it anyway rather
   than claim the category does not exist, and we report the 0 honestly.
2. **`missing-vector`** — a row with no `vector` / `embedding` field, or an empty one. Real: the
   pasted-document door (`/api/knowledge/docs` POST) writes text with **no embedding at all**, so
   those rows are invisible to k-NN while looking like corpus.
3. **`dimension-mismatch`** — the index's own `knn_vector` mapping dimension ≠
   `config.filesEmbedDim` / `config.embedDim`. OpenSearch rejects a per-row wrong length at write
   time, so this is an INDEX-level fact, not a row-level one: when it is true, **every** row is
   un-queryable (index-time and query-time vectors can never match). Detected from the mapping,
   which is exact and costs one GET.
4. **`missing-representation`** — a stored unit that has NO row in the index at all: a Files asset
   whose `indexing.mode` is not `stored-only` and which the index does not mention (the parser
   produced nothing, or the refusal stopped it), or a Knowledge workflow with no indexed units.

And the category that matters most:

5. **`unmarked`** — fabricated before PR #56, carrying none of the four. **Not findable.** The
   only remedy is the `all` filter, which re-parses and re-embeds everything.

This asymmetry is stated in the plan, in the tool description, in the route's response and in the
UI copy. A tool that implied `marked` was a clean-up would be the same class of lie the gate
exists to prevent.

## 2. Required outcome

1. Tab-owned re-index services — no re-index logic in `core/` — exposing `planReindex` (a dry
   run: counts per reason) and `runReindex` (the work), which re-parse and re-embed through the
   **same live paths the ingest uses today**, refuse rather than fall back, are idempotent,
   resumable from a cursor, bounded per batch, and never delete a row they could not replace.
2. Two admin doors: `POST /api/platform-admin/reindex` and the MCP tool `reindex_corpus`.
3. A "Re-index" section in Platform: Plan → counts → Run → progress → result, disabled with the
   reason when the engines are unreachable.
4. Honest reporting throughout (§1.1).

## 3. The design

### 3.1 Where the code lives, and why

```
core/kernel/reindex.ts              the CONTRACT + the job table   (types, pure, no tab imports)
tabs/files/lib/reindex.ts           the files service              (plan · run · probe)
tabs/knowledge/lib/reindex.ts       the knowledge service          (plan · run · probe)
core/mcp/reindex-tools.ts           reindex_corpus, as a FACTORY over injected services
core/mcp/register-experimental.ts   one new bundle: loads both tab services, injects them
app/api/platform-admin/reindex/route.ts   the HTTP door (adminCtx + audit)
tabs/admin/lib/reindex-view.ts      the section's pure view model + the honest copy
tabs/admin/ui/ReindexSection.tsx    the section
```

Three constraints shaped this and none of them bent:

* **A tab imports only `@core/*` and itself.** One tool that can target both corpora may
  therefore not live in either tab. It lives in `core/mcp/reindex-tools.ts` as
  `reindexTools(services)` — a factory over a `Record<ReindexTarget, ReindexService>` — so the
  kernel file holds the tool's shape, gate and description and imports **no tab at all**. The
  wiring happens in `register-experimental.ts`, which already loads every tab bundle by dynamic
  `import()` for code-splitting; the two tab services are loaded there and handed in.
* **The kernel never imports a tab.** `core/kernel/reindex.ts` is types plus a `globalThis`-keyed
  job table. It is the same move `core/manifest.ts` makes for `TabManifest`: the contract in the
  kernel, the implementation in the tabs — and it is what makes "one running job per target" a
  single fact rather than two tabs' conventions that could drift.
* **Files and Knowledge mirror each other by design.** `embed.ts`, `index-pipeline.ts` and
  `index-store.ts` already exist once per tab (`knowledgeIndexMapping` says "mirrors
  `filesIndexMapping`"). The two `reindex.ts` modules follow that grain rather than inventing a
  shared engine neither tab may import.

### 3.2 The contract (`core/kernel/reindex.ts`)

```ts
type ReindexTarget = 'files' | 'knowledge';
type ReindexFilter = 'marked' | 'all';
type ReindexReason  = 'marked' | 'missing-representation' | 'missing-vector'
                    | 'dimension-mismatch' | 'all';

type ReindexPlan = {
  target: ReindexTarget; filter: ReindexFilter;
  counts: Record<ReindexReason, number>;   // rows, per reason — the dry run's answer
  units: ReindexUnit[];                    // what a run would process, in order
  rowsTotal: number;
  mappingDim: number | null; configuredDim: number;
  engines: EngineProbe[];                  // probed FIRST; `ready` gates the Run button
  ready: boolean; blockedReason: string | null;
  unmarkedCaveat: string;                  // §1.1(5), carried in the payload, not just the UI
};

type ReindexJob = {
  id: string; target: ReindexTarget; filter: ReindexFilter;
  status: 'running' | 'done' | 'failed';
  total: number; cursor: number;           // cursor = units completed → resume point
  replaced: number; failed: number; skipped: number;
  startedAt: string; updatedAt: string; finishedAt: string | null;
  by: string; failures: { unit: string; reason: string }[];  // capped
  error: string | null;
};
```

The job table is `globalThis`-keyed per target (`Symbol.for('soa.reindex.jobs')`), exactly like
`tabs/files/lib/index-store.ts`'s index. `startJob` **refuses** when a job for that target is
already `running` — that is the one-job-per-target invariant, in one place, so the HTTP door and
the MCP door cannot disagree. A second call returns the running job (`started: false`), it does
not start a twin and it does not error.

### 3.3 `planReindex(principal, opts)` — read-only

1. `assertAdmin(principal)` — `roleAtLeast(role, 'admin')`, else a 403-tagged `Error`.
2. Probe the engines the run will need (bounded, 2.5 s, the `queryToolReachable` pattern):
   files → Docling `GET {doclingUrl}/health` **and** the gateway `GET
   {litellmUrl}/health/liveliness`; knowledge → the gateway only (its "re-parse" is a re-chunk of
   the authoritative workflow document, which needs no parser service).
3. Read the index mapping once → `mappingDim`; compare with the configured dim.
4. Count rows per reason with `_count` queries (`marked`, `missing-vector`, `all`), and
   `dimension-mismatch` = `all` when the mapping disagrees, else 0.
5. Enumerate the units a run would touch: a `terms` aggregation on the unit key (`file_id` /
   `workflow_id`), capped, over the selected filter; plus — for `missing-representation` — the
   stored units the index does not mention at all (`listAllForIndex()` / `listWorkflows`).
6. Return the plan. **A plan never writes and never needs the engines up** — it is the honest
   answer to "how bad is it", and it must work during the outage that caused the damage.

### 3.4 `runReindex(principal, plan, { onProgress })` — the work

* Admin re-checked. `startJob` enforces one-job-per-target.
* **Refuse, never fall back.** The probe runs again at the top: unreachable ⇒
  `refuseOfflineMock(...)` — the house-typed `ENGINE_UNAVAILABLE` (503), which `structuredError`
  already maps for MCP and the route maps for HTTP. **No row is touched** on that path: the probe
  precedes every write.
* Bounded: `batch` units per call (default 25, max 200). Returns with the job still `running`
  when units remain, so a long corpus is many short calls rather than one request that dies.
* Resumable: the job's `cursor` is "units completed". A `run` that finds a `running` job for the
  target resumes from `cursor` instead of starting over. An interrupted batch therefore costs at
  most that batch.
* **Per unit, through the same live path:**
  * files → `indexAsset(asset, text, { live: true, reembed: true, awaitMirror: true })` — the
    very function the upload route calls, with the live adapter and the live embedder. Then the
    result's own honesty fields are checked: `ingestMode`/`embedMode` ≠ `live` ⇒ the unit is a
    **failure**, nothing is pruned, the old rows stay. (On a laptop, `OS_OFFLINE_MOCK=allow`
    lets the ingest mock itself; a re-index that accepted that would re-poison the index it was
    asked to clean, so the re-index demands `live` regardless of the switch.)
  * knowledge → `indexWorkflow(workflow, { owner, tacit, updatedAt, caller })` /
    `indexDomain(dk)`; a standalone pasted doc (no `workflow_id`) is re-embedded from its stored
    text and updated in place by `_id`. Report `store: 'memory'` (the OpenSearch write failed) ⇒
    failure.
* **Never delete a row it could not replace.** Two changes make that true rather than hoped-for:
  * files: `indexAsset` returns its `chunkIds`; the service prunes *stale* chunks only after the
    bulk write confirmed, with `_delete_by_query` on `file_id = X AND NOT ids(newIds)`.
  * knowledge: `writeOpenSearch` currently **deletes the scope then bulk-adds**, so a failed bulk
    loses the scope. Unit ids are stable, so an index op overwrites in place: the order is
    inverted to **add, then prune what the add did not cover**. Strictly safer, idempotent, and
    it fixes a hazard that pre-dates this branch.
* Attribution: the acting admin, through `actingCaller(userId, domain)` — the embedding spend
  belongs to the object's domain and the person who pressed the button (checklist A27).
* Audit: one `recordAudit` row per run call at the route, and the job id in the response.

### 3.5 Honesty, as a payload field and not a comment

`ReindexPlan.unmarkedCaveat` carries §1.1(5) in the plan body, so an agent reading the JSON and a
person reading the panel get the same sentence: *"Rows fabricated before the production guard
that carry no marker cannot be found by `marked` — a hash vector is indistinguishable from a real
one once written. Only `filter: 'all'` re-does those."* The tool description says it; the panel
prints it next to the Run button; the result repeats it when `filter: 'marked'`.

### 3.6 The tripwire needs a fourth category

Both services name stand-in markers (they query for `'offline-hash'` / `mode: 'mock'` and check
an ingest result's mode), and both call `refuseOfflineMock`. Under
`core/kernel/offline-mock-tripwire.test.ts` today that is a contradiction: DECIDERS *choose* to
fabricate; LABELS may not import the module; a reachability probe is explicitly a LABEL. A
refuse-only consumer is neither. So the tripwire gains **REFUSERS**: files that import the
predicate module, call `refuseOfflineMock(` and **never** call `offlineMockAllowed(` — i.e. they
can only ever refuse, never opt in. That is a real assertion (it would fail if someone later let
the re-index fall back) and it keeps the test's stated contract — "widening the set is cheap and
is how this test stays honest" — rather than mis-filing two new files to keep a list short.

## 4. Doors

### 4.1 `POST /api/platform-admin/reindex`

Body `{ target: 'files'|'knowledge', mode: 'plan'|'run', filter: 'marked'|'all' }`.
`adminCtx()` (401 anon / 403 non-admin / tenant-pinned), audited, `fail(e)` maps the typed refusal
to its own 503 + code. `GET ?target=…` returns the job status alone, so the panel can poll without
a write. The route is thin: every decision is in the services, because a `route.ts` cannot be
imported by a test.

### 4.2 MCP `reindex_corpus`

`minRole: 'admin'`, `tab: 'files'`, `extraTabs: ['knowledge']` (the `extraTabs` case the
promotion tools already use). Same argument shape as the route. Reports like the other long tools
(`sync_dataset_now`): `{ started: boolean, job: {...} }`, and when a job is already running
`{ started: false, reason: 'already-running', job }` — progress, never a twin, never a phantom
success. Plan mode returns the plan with its caveat.

## 5. The tests (test-first)

| File | Asserts |
|---|---|
| `core/kernel/reindex.test.ts` | the job table: one running job per target, cursor/resume arithmetic, a second start returns the running job, `done`/`failed` transitions, both targets run independently |
| `tabs/files/lib/reindex.test.ts` | plan counts per reason over fixtures **with and without** markers; `all` ≥ `marked`; dimension mismatch from the mapping; missing-representation from the store; run REFUSES `ENGINE_UNAVAILABLE` when the gateway/Docling is down **and no row is touched**; run replaces marked units and leaves the others; a unit whose ingest came back `mock` is a failure and its old rows survive; resumable after an interrupted batch; idempotent; non-admin 403 |
| `tabs/knowledge/lib/reindex.test.ts` | the same over the knowledge index, plus: a standalone pasted doc is re-embedded in place, add-then-prune never leaves a scope empty on a failed write |
| `core/mcp/reindex-tool-gate.test.ts` | the tool is `minRole: 'admin'`, a creator/builder/domain_admin cannot call it, the shape matches the route's, a second call reports `already-running` |
| `tabs/admin/lib/reindex-view.test.ts` | the view model: disabled + reason when a probe is down, the honest `marked`-vs-`all` copy is present, counts render per reason |
| `core/security-route-guards.test.ts` (sweep) | the new route is `adminCtx`-gated — plus an explicit assertion in the files test that it names `adminCtx` |
| `core/kernel/offline-mock-tripwire.test.ts` | REFUSERS: both services import the predicate, call `refuseOfflineMock(`, never `offlineMockAllowed(` |

Fixtures stub `globalThis.fetch` per the `tabs/*/lib/embed.test.ts` pattern; no network, no
cluster. `.tsx` is never imported (the section's logic is in `reindex-view.ts`).

## 6. Gates

`os-ui/node_modules/.bin/tsc --noEmit -p os-ui` · the targeted test files · **one** full-suite run
(`node --experimental-test-module-mocks --import ./scripts/test-setup.mjs --test
--test-concurrency=2 'core/**/*.test.ts' 'tabs/**/*.test.ts'`) · `bash os-ui/scripts/gate.sh` ·
`node scripts/check-structure.mjs` must not rise above **419 / 1 / 200 / 1230**.

## 7. What an operator does

```bash
# 1. Dry run — safe during the outage, writes nothing.
curl -sS -X POST https://<host>/api/platform-admin/reindex \
  -H 'content-type: application/json' \
  -d '{"target":"files","mode":"plan","filter":"marked"}'

# 2. Read `engines[].ready`. Anything false ⇒ start that component, do not run.
# 3. Run, repeatedly, until `job.status` is `done` (each call does one bounded batch).
curl -sS -X POST https://<host>/api/platform-admin/reindex \
  -H 'content-type: application/json' \
  -d '{"target":"files","mode":"run","filter":"marked"}'

# 4. Poll without writing.
curl -sS 'https://<host>/api/platform-admin/reindex?target=files'

# 5. Repeat 1-4 with "target":"knowledge".
```

Through MCP, as an admin: `reindex_corpus {target:'files', mode:'plan', filter:'marked'}` then
`mode:'run'`. In the UI: Platform → Re-index → Plan → Run.

**Use `filter:'all'` when the cluster ran with unreachable parsers or an unreachable embeddings
gateway and you cannot bound when** — `marked` can only find rows that still carry evidence.
`all` re-parses and re-embeds every unit, costs real gateway spend, and is the only complete
answer.

## 8. Deliberately out of scope

* No deletion of rows whose source unit is gone — that is a lifecycle decision (`deleteFile`,
  `purgeKnowledgeUnits`), not a re-index's, and a re-index that deleted would be the one failure
  mode this plan promises not to have.
* No schedule. A re-index is an operator act with a cost; an unattended one that refuses nightly
  is noise, and one that silently succeeds is how this debt accrued.
* No backfill of a persisted honesty marker onto old rows. We cannot know which rows deserve it;
  inventing provenance would be a new fabrication.
* `app/api/knowledge/docs` POST keeps writing an un-embedded doc. Fixing that door is a separate
  change; the re-index's `missing-vector` reason is what makes its output retrievable meanwhile,
  and §8 records the gap rather than hiding it.

## 9. Outcome (TEST phase, 2026-11-19)

Built as planned, with four decisions worth recording because they changed the shape:

1. **`dimension-mismatch` is read from the MAPPING, not from the rows.** OpenSearch rejects a
   wrong-length `knn_vector` at write time, so no row can individually carry a bad length — but an
   index whose mapping dimension no longer equals `config.filesEmbedDim` / `config.embedDim` makes
   **every** row un-queryable. One `_mapping` GET answers it exactly, and the count is reported as
   the whole row total rather than a sample.
2. **A fourth tripwire category, `REFUSERS`.** The two services name the markers (they query for
   them) and call `refuseOfflineMock`, but they have no fabricating branch: DECIDERS overstates
   them, and LABELS may not import the predicate at all, which would have forced them to swallow
   the refusal. A refuser must call `refuseOfflineMock(` and may never call `offlineMockAllowed(`
   — asserted, so a future edit that let a re-index fall back fails CI.
3. **The run checks the mode it got back.** On a laptop the switch permits a stand-in, so a run
   that trusted the pipeline would rewrite the very rows it was started to remove. Each unit's own
   report is read (`ingestMode` / `embedMode` / `embedSource` / `store`) and anything but live is a
   failure with the existing rows left in place — the honest reading of a report that was always
   there.
4. **`reindex_corpus` is classified in `WRITE_TOOL_TABS`.** It is built by a factory, so it is not
   in `ALL_WRITE_TOOLS` (a barrel of static arrays) — exactly the gap review H-1 closed for
   `commit`: an unclassified write answers "not a write" for every preset and runs unheld. The
   equality test gained a third, documented source.

Also fixed on the way through, because the requirement demanded it: the Knowledge index writer
**deleted a scope before bulk-adding it**, so a failed or unreachable write left a workflow with
no indexed units at all. Unit ids are stable and an index op overwrites in place, so it now adds
and then prunes only what the add did not cover, and prunes nothing when the add did not land.

### Tests

| Suite | Tests |
|---|---|
| `core/kernel/reindex.test.ts` (job table + the pure plan assembly) | 23 |
| `tabs/files/lib/reindex.test.ts` | 28 |
| `tabs/knowledge/lib/reindex.test.ts` | 22 |
| `core/mcp/reindex-doors.test.ts` (MCP gate + route gate + registration) | 22 |
| `tabs/admin/lib/reindex-view.test.ts` (the panel's copy and disabled-state) | 10 |
| `core/kernel/offline-mock-tripwire.test.ts` | 9 (was 8 — REFUSERS) |

### Gates

| Check | Result |
|---|---|
| `os-ui/node_modules/.bin/tsc --noEmit -p os-ui` | **exit 0**, no output |
| full suite (`core/**` + `tabs/**`, concurrency 2) | **exit 0** — 6668 tests, 6664 pass, **0 fail**, 4 todo |
| `bash os-ui/scripts/gate.sh` | **exit 0** — 436 tests, 432 pass, 0 fail, 4 todo |
| `node scripts/check-structure.mjs` | **exit 0** — ratchet unmoved: `419 / 1 / 200 / 1230` |

### Open, deliberately

- `app/api/knowledge/docs` POST still writes a document with **no embedding**. The re-index's
  `missing-vector` reason is what makes those rows retrievable meanwhile; fixing the door is a
  separate change (§8).
- The job table is **in-process**. A pod restart mid-run loses the cursor, not the work: a fresh
  plan + run is idempotent and re-does at most what the lost batch had not finished.
- `filter: 'all'` is the only complete remedy and nobody can tell an operator how much of the
  corpus needs it, because the evidence was never written. The tool says so in every payload
  rather than implying `marked` is a clean-up.
- No schedule, no auto-run, and no backfill of a provenance marker onto old rows (§8).

## 10. Review round (PR #64, 2026-11-19) — H1–H3 blocked merge, M1 landed with them

An independent review found three blockers and four mediums. Per finding:

### H1 (block) — an agent run could execute `reindex_corpus` UNHELD. **Fixed, twice over.**
`WRITE_TOOL_TABS` made the tool *visible* to the hold gate; `writeTargetScope` then answered
`personal`, because it defaults every unclassified write to "the runner's own work". So under any
preset but `read-only`, a granted agent could have fired a tenant-wide re-index with no human in
the loop — the `commit` / `push_app_files` lesson one rung up.
*How:* (1) `COMPANY_SCOPE_TOOLS` in `tabs/agents/lib/build/hold.ts` → `writeTargetScope` returns
`company`, so `holdDecision` holds it to a platform **admin** under every preset. (2) And held is
not the posture we want for this one: `AGENT_FORBIDDEN_TOOLS` in `core/mcp/write-tool-meta.ts`
closes it to agent runs outright. `os-tools.ts` gained **gate 0** — ahead of the grant check, so
the caller gets the real reason — and `grantedMcpTools` drops it from the advertised schemas, since
a model will try whatever it can see. An admin still runs it from the panel, the HTTP door or their
own MCP session: all three are a person, present, choosing.
*Test:* `os-tools.test.ts` — company scope pinned beside the personal/domain families, held to
`admin` for all four presets, the gate-0 refusal (granted, `full-in-scope`, still refused, nothing
dispatched and nothing enqueued), and never advertised. `write-tool-meta.test.ts` asserts every
agent-closed tool is also a classified write, so the hold stays the second line if the refusal ever
goes.
**Not done, deliberately:** the same two lines in `callAppTool`. That file is
`tabs/software/lib/app-tool-call.ts`, inside the `tabs/software/**` path this branch was told not
to touch (another agent owns it). The OS tool is not reachable through that door — it executes an
app's own tools — so the residual exposure is an `actions.yml` **name-squatting** on
`reindex_corpus`, which cannot reach the OS re-index. The catalog is already in `core/`, so the
guard is a two-line change for whoever owns that file.

### H2 (block) — Continue was greyed out exactly when it was needed. **Fixed.**
`runDisabledReason` disabled on `job.status === 'running'`, and a job left `running` by an
interrupted polling loop, a closed tab or a failed batch is *precisely* what must be continued.
*How:* the server now reports `inFlight` (its own `busy()` flag) from `GET
/api/platform-admin/reindex` and from `reindex_corpus {status:true}`, and the panel gates on THAT.
A running job with no batch in flight is continuable **and needs no fresh plan** — the job's work
list and cursor are the facts.
*Test:* `reindex-view.test.ts` — running + not in flight ⇒ enabled, with and without a plan; in
flight ⇒ disabled with the reason.

### H3 (block) — nothing could clear a stuck job. **Fixed.**
`busy` is process state; a pod killed between batches left the target wedged forever (every
Continue answering `already-running`) with only a test hook to clear it.
*How:* `abandonReindex(principal)` on both services — admin-only, marks the running job **failed**
naming who abandoned it and at what cursor, clears the work list and the in-flight flag, and
touches no row. Exposed as `POST {mode:'abandon'}` (audited `reindex.abandon`), MCP
`mode:'abandon'`, and an **Abandon** button that appears only for a running job that is not
mid-batch. A batch that is mid-flight when an abandon lands stops at the next unit boundary rather
than spending budget on an answer nobody will read.
*Test:* 4 files + 2 knowledge + 3 MCP + 2 route-source.

### M1 (with the blockers) — a stand-in was WRITTEN before it was detected. **Fixed.**
The honesty check lived in the caller: the service read `ingestMode` / `embedMode` /
`embedSource` off the report — one statement after `indexAsset` had written the in-process index
and awaited `bulkIndex`, and after `writeOpenSearch` had written **and pruned**. With
`OS_OFFLINE_MOCK=allow`, an engine falling over mid-run would therefore have overwritten good rows
with placeholder text and hash vectors.
*How:* a `requireLive` opt on `indexAsset` / `indexWorkflow` / `indexDomain` that raises the typed
refusal **after** the parse/embed and **before** any write. The services bind it in their live
deps; `verdictOf` and the report checks stay as a second line for a future caller that forgets it.
Both module headers say why the check cannot live in the caller.
*Test:* one per corpus driving the REAL `LIVE_UNIT_DEPS` with a faked gateway (502) and a faked
Docling, asserting the typed refusal **and** that no `_bulk` / `_delete_by_query` / `_update` call
happened and the in-process index is untouched.

### M2 — "existing rows left in place" was not true on an empty parse. **Fixed.**
`indexAsset` called `removeFromIndex` on `status: 'empty'`. A `keepOnEmpty` opt (set by the
re-index only) keeps them; every other caller's behaviour is unchanged, and that is asserted.

### M3 — the marked help singled out Files. **Fixed.** It now says no writer in EITHER index ever
stamped such a label, and that Knowledge's `source` holds provenance (`os-ui-ingest`). The
knowledge service's header and marker docstring were softened the same way.

### M4 — the panel looped up to 500 POSTs with no estimate, no confirmation and no batch size.
**Fixed.** The operator picks the batch size (10-200, sent in the body), sees `runEstimate`
(units · rows · batches, and that it costs real gateway budget) before starting, and must confirm
`all` with the numbers in front of them. The loop is bounded by the estimate rather than a magic
500, and a `run` against a running job **resumes without re-planning** at both doors
(`runReindex(principal, null, …)`), so a long corpus costs one plan and N cheap batches.

### Lows
1. `pruneScopeExcept` gained a `prefix` clause on `_id` so a domain card's SECTION units — which
   carry no `workflow_id` — are swept. (The same gap exists in `purgeKnowledgeUnits`; left alone
   because changing delete semantics is outside this branch — recorded here instead.)
2. A pasted doc is billed to its own `_source.domain`, not to `''`.
3. The audit line records `out.job.filter` (the running job's), not the request's.
4. A resumed job whose work list was lost now **fails** with a reason, instead of indexing a stale
   cursor into a freshly computed list.

### Gates for this round (scoped, as instructed — no full suite)

| Check | Result |
|---|---|
| `core/kernel/*` + `core/mcp/*` + `tabs/{files,knowledge,admin}/**` + `tabs/agents/lib/{build,builtin}/*` + route guards | **exit 0** - 1711 tests, 1708 pass, **0 fail**, 3 todo |
| `os-ui/node_modules/.bin/tsc --noEmit -p os-ui` | **exit 0**, no output |
| `node scripts/check-structure.mjs` | **exit 0** - ratchet unmoved `419 / 1 / 200 / 1230` |

The tripwire's REFUSERS list now also holds the two index **writers**, because `requireLive` made
them refuse: they do not choose a stand-in, they are handed one, and their job is to decline before
the write.

## 11. Re-review (PR #64, 2026-11-19) — MERGE with two edits

### (1) The catalog's docstring claimed a guard that does not exist. **Fixed.**
`AGENT_FORBIDDEN_TOOLS` said both agent-facing doors consult it. Only
`tabs/agents/lib/build/os-tools.ts` does. A comment that overstates a guard is worse than no
comment — the next reader stops looking — so it now names the one real consumer and states the app
door as an open FOLLOW-UP, with why the residual exposure is name-squatting only and why this
branch cannot close it (`tabs/software/**` is owned elsewhere). A test pins the wording so it
cannot drift back while the follow-up is open.

### (2) New M — a stale loop could advance the NEXT job's cursor. **Fixed.**
`abandonReindex` clears the in-flight flag so the target can be re-run, but it cannot un-await a
unit that is already inside the parser or the gateway. A new job then claims the slot; the stale
unit resolves and reports progress. `recordUnit` was keyed by TARGET only, so that report landed
on the NEW job — and the loop guard (`status !== 'running'`) passed, because the slot's job really
was running: somebody else's. The new job could therefore reach `done` with units nobody
re-indexed, which is the exact class of false claim this branch exists to prevent.
*How:* `recordUnit(target, jobId, …)` — the caller says which job it believes it is advancing, and
a report for any other job is **dropped**; both run loops now break on `current.id !== job.id ||
current.status !== 'running'`. Naming the job is the only way to be right about this: no ordering
or status check by the caller can be, because the await is already in flight when the slot changes
hands.
*Test:* kernel — a report naming a job that no longer holds the slot is dropped and the new job's
counters are untouched; files — the race end to end (abandon mid-await → a new job takes the slot
→ the stale unit resolves): the new job stays at 1/2 `running`, the stale unit is not counted, and
the abandoned loop stops instead of working through its batch.

### Gates for this edit

| Check | Result |
|---|---|
| `core/kernel/*` + `core/mcp/*` + the two re-index suites + the panel + os-tools | **exit 0** - 753 tests, 750 pass, **0 fail**, 3 todo |
| `os-ui/node_modules/.bin/tsc --noEmit -p os-ui` | **exit 0**, no output |
| `node scripts/check-structure.mjs` | **exit 0** - ratchet unmoved `419 / 1 / 200 / 1230` |
