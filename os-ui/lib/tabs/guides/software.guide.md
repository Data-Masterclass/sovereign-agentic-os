# Software — golden path

## What this is

The Software tab is where apps are built and governed. An app is a **validated AppSpec of cookbook-pattern tabs over governed data**, served **same-origin** by the trusted OS renderer under the viewer's session — **no Forgejo repo, no CI, no image, no pod**. You author it declaratively (author the tabs over granted data), and it is **live at `/apps/<slug>` the moment its spec validates** — no build latency. Software is the most dependency-rich surface in the OS: it consumes governed datasets, published knowledge, promoted connections and governed metrics — all by reference, never by copying. A running app can also export its output back to the Bronze tier via `use_as_data`, closing the cross-tab spine loop.

**Declarative is the default and the golden path.** The historic CODED path (raw code + Forgejo + CI + image build) is an ADVANCED option that is **OFF by default** and **platform-admin-gated** — `create_software` with `kind:'code'` and the `commit` tool fail closed with a clear message unless a platform admin has enabled coded apps.

## The golden path (declarative — MCP)

An external agent (Claude / Codex) walks the SAME governed stages the UI does; each tool reuses the governed server function the UI calls, so role gates, validation and audit apply automatically.

0. **Reuse check.** `list_software` to see what exists in your domain; `get_software` / `get_app_spec` to inspect a specific app before forking it.
1. **Define — `create_software`.** Pass `name`, an optional `domain`, `purpose`, and `surface` (`ui` | `api` | `both`). `kind` **defaults to `'spec'`** — a declarative app with NO image pipeline, servable the moment you author its spec. (No `template` needed; templates only shape a coded scaffold.)
2. **Design + Choose Context — `design_software`.** Author the specification tree: `purpose`, `epics` (each with user stories + a per-story `spec` of features / NFRs / rules), AND bind governed context with `grants` (existing datasets / metrics / knowledge / connections / files — by reference, never credentials). Every dataset a tab will read must be granted here.
3. **Author the app — `generate_app_spec` OR `set_app_spec`.**
   - **`generate_app_spec`** — the one-call scaffold: reads your designed epics + user stories + granted data (datasets with their REAL columns, metrics, agents) and asks the OS reasoning model to compose a complete, validated AppSpec whose tabs are cookbook patterns wired only to granted ids + real columns. Returns `{ ok:true, spec }` (a validated spec, not yet persisted) — review it, then publish with `set_app_spec`.
   - **`set_app_spec`** — the author-and-publish door. Set the validated AppSpec `{ version:2, name, description, theme?, functions?, tabs:[] }`. Each tab is a cookbook **pattern** (`{ kind:'pattern', pattern, config }`) or a sandboxed **custom** block (`{ kind:'custom', html, css?, js?, data? }` — a null-origin iframe that can never act as the user). A data-backed pattern's `source.datasetId` must be a **granted** dataset and every referenced column must be **real** — call `get_dataset` to discover exact column names. Optional app-wide `theme.css` (scoped under the app root; no `<`/`>`) and governed query/expression `functions` (rendered by a KPI card's `functionId`). **A governed author = a versioned publish:** on success the spec goes LIVE and a version is snapshotted; `{ ok:true, servedUrl:'/apps/<slug>', version }`. On any blocking issue it returns `{ ok:false, issues:[{path,reason,fix}] }` and persists nothing.
4. **Live.** The app serves at `/apps/<slug>` immediately. `get_app_spec` reads the live spec (+ a plain-language `describe` legibility summary) for read-modify-write. Climb the ladder with `promote`; `archive` / `delete` (lineage-blocked) for lifecycle.

**Wire dependencies by reference** (design/author time): a tab may only read a dataset the app was granted; `use_data` / `use_knowledge` / `use_connection` formally bind a granted asset. **Close the loop:** `use_as_data` registers the app's output as a Bronze dataset.

**Model tiers:** Define — no LLM. Design — reasoning. `generate_app_spec` — reasoning (composes the spec). `set_app_spec` — no LLM (pure validate + persist).

## Implemented cookbook patterns

- **View (read):** `records-table`, `master-detail`, `detail`, `status-board`, `kpi-overview`, `chart-explorer`, `card-gallery`, `timeline`, `calendar`, `landing`.
- **Interactive (write via the governed `os.records` door + role gates — never arbitrary code):** `form`, `intake-wizard`, `assignment`, `approval-queue`, `task-checklist`.

The registry in `appspec/patterns.ts` is the source of truth; a spec referencing a not-yet-implemented pattern parses cleanly and renders an honest "coming soon" placeholder.

## Advanced — the coded path (admin-enabled only)

CODED apps (`kind:'code'`) build raw code through Forgejo + CI + an image build. This path is **DISABLED by default** and only works when a platform admin has enabled coded apps. When enabled, the staged flow is `create_software(kind:'code')` → `design_software` → `build_software` (returns the governed build directive + committed files, design-before-build gated) → author code → `commit` (Developer mode, Builder+; direct file write) → `verify_software` (5-dimension test) → `start_preview` / `request_deploy` → a Builder `decide_deploy`. `commit` is role-gated to Builder/Admin and fails closed (403) when coded apps are off — author a declarative app with `set_app_spec` instead.

## What to consider

- **Grant before you author.** A tab that reads a dataset the app wasn't granted, or references a column that doesn't exist, is a BLOCKING validation issue — `set_app_spec` returns a machine-actionable `{ path, reason, fix }` and persists nothing.
- **`get_dataset` for real columns.** Never invent a column name; discover them first.
- **delete is lineage-blocked.** If something depends on this app's output, `delete` returns `conflict` — use `archive`.
- **`use_as_data` closes the spine.** The Bronze dataset it creates inherits the app's lineage, making the data → software → data chain traceable.

## Governance

| Step | Role required |
|---|---|
| `list_software`, `get_software`, `get_app_spec`, `generate_app_spec` | Creator (visibility-gated) |
| `create_software`, `design_software`, `set_app_spec`, `use_data`, `use_knowledge`, `use_connection`, `archive` | Creator (owner / owning-domain builder+ for the spec doors) |
| ⛔ `promote` | Builder or Admin |
| ⛔ `commit` (Advanced coded path — direct file write; disabled when coded apps are off) | Builder or Admin |
| `delete` | Creator (lineage permitting) |

Every author runs AS you, is OPA-policy-checked and Langfuse-traced. A governed `set_app_spec` author is a versioned publish, at parity with the UI Publish.

**Worked example (declarative):**

```
list_software({ domain: "sales" })
→ [{ id: "sw_22A...", name: "orders-app", state: "live" }]

create_software({ name: "Orders desk", domain: "sales", purpose: "Triage and view orders" })
→ { id: "sw_33B...", serveMode: "spec", state: "draft" }        # DEFINE (declarative by default)

design_software({ appId: "sw_33B...",
  epics: [{ id: "epic_1", title: "Orders", stories: [
    { id: "story_1", title: "See open orders", asA: "rep", iWant: "a table of open orders", soThat: "I can triage",
      spec: { features: ["List orders"], nfrs: [], rules: [] } }] }],
  grants: { data: [{ id: "ds_01J...", access: "read-only" }] } })   # DESIGN + CHOOSE CONTEXT

get_dataset({ id: "ds_01J..." })                                   # discover REAL columns
generate_app_spec({ appId: "sw_33B..." })                          # ✨ scaffold a validated spec from the design
→ { ok: true, spec: { version: 2, tabs: [{ body: { kind: "pattern", pattern: "records-table", … } }] } }

set_app_spec({ appId: "sw_33B...", spec: <the reviewed spec> })    # AUTHOR = versioned PUBLISH
→ { ok: true, servedUrl: "/apps/orders-desk", version: { name: "v1", … } }   # LIVE, no build
```

If instead you author by hand, skip `generate_app_spec` and pass your own `{ version:2, name, description, tabs:[…] }` straight to `set_app_spec` — the validator gates it identically.
