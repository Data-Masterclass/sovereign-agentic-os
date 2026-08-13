# Declarative AppSpec — Software-tab Hybrid foundation (Track 2)

**Status:** approved 2026-08-12 (Alex). Serving model: **same-origin, OS-rendered (no pod)** for declarative apps; raw-TSX image/pod path kept only for ejected apps. See memory `software-hybrid-declarative-redesign`.

## Why
Most Software-build fragility is accidental, downstream of two bets: (1) an app must be an independently built+deployed Docker image/pod (→ cross-origin identity, silent CI, Kaniko, registry/PVC, status lies) and (2) the build agent authors raw React/TSX against a vendored API (→ compile loops, guidance drift: the `useIdentity`/`app/`-vs-`src/`/`createOsClient()` class). The governance spine (OPA, DLS, audit, git-backed versioning, My/Domain/Company) is essential and unchanged.

**Hybrid:** the DEFAULT for data-backed apps is a **validated declarative AppSpec** rendered by a **trusted, same-origin OS renderer**. The agent fills a small closed schema instead of writing code, so prop names, imports, `useIdentity`, column mapping, and cross-origin data auth become impossible to get wrong. A raw-TSX **eject** stays for the long tail.

## AppSpec (the contract — the hand-written validator on the server IS the gate)

**v2 (Phase 3.5a): tabs · patterns · custom.** An app is a set of TABS; each tab renders either
a named cookbook PATTERN (config-only recipe) or a sandboxed CUSTOM html/css/js block. This
replaces the v1 `sections:[{view}]` shape (a Section was a one-view tab). Nothing in production
used v1 specs, so the grammar was migrated cleanly — `version` is the literal `2`.
```
AppSpec { version:2, name, description, theme?:{ css? }, tabs: Tab[], functions?: AppFunction[] }   // functions[] built 3.5d
Tab = { id, label, icon?, roleGate?: 'creator'|'builder'|'domain_admin'|'admin', body: TabBody }
TabBody =
  | PatternBody { kind:'pattern', pattern: PatternId, config: <per-pattern> }
  | CustomBody  { kind:'custom', html, css?, js?, data?:{ datasetId, as? } }   // SANDBOXED iframe
theme.css = author CSS, applied SCOPED under the app-root class (cannot leak into the OS chrome)
```
Reused leaf grammar (unchanged from v1): `TableColumn {field,label?,format?}`,
`TableFilter {field,control}`, `DetailField`, `FormField {name,label,type,required?}`,
`format = 'text'|'number'|'currency-eur'|'date'|'badge'`, `control = 'select'|'search'|'range'`.

### Pattern cookbook (`patterns.ts`)
A registry: `PatternId → { id, label, category, description, implemented, parseConfig, summarize }`.
All ids are valid grammar tokens (a spec referencing a not-yet-built one parses + renders an honest
"coming soon" placeholder). `category` splits VIEW (reads) from INTERACTIVE (writes via the
governed `os.records` door / role gates — never arbitrary code). `summarize(config)` is the
plain-language line the legibility surface (`describeApp` → "How this app works") uses.

| Pattern | Category | 3.5a | What |
|---|---|---|---|
| `records-table`  | view | ✅ built | searchable/filterable/sortable/paged table |
| `detail`         | view | ✅ built | pick one record, read its fields |
| `status-board`   | view | ✅ built | records grouped into columns by a status field (tiles) |
| `master-detail`  | view | ✅ built (3.5b) | list + selected record detail |
| `kpi-overview`   | view | ✅ built (3.5b) | grid of headline metric/aggregate cards |
| `chart-explorer` | view | ✅ built (3.5b) | a governed metric charted by dimension + time (ECharts) |
| `card-gallery`   | view | ✅ built (3.5b) | records as a searchable card gallery |
| `timeline`       | view | ✅ built (3.5b) | records on a vertical time axis (newest first) |
| `calendar`       | view | ✅ built (3.5b) | records on a month calendar |
| `landing`        | view | ✅ built (3.5b) | composed home page: prose + KPIs + featured table |
| `intake-wizard`  | interactive | ✅ built | multi-step form → one governed `os.records.add` |
| `form`           | interactive | ✅ built (3.5c) | single-screen create → one governed `os.records.add` |
| `assignment`     | interactive | ✅ built (3.5c) | pick item + assignee (2 granted datasets) → append `{itemId,assigneeId,…,at}` |
| `approval-queue` | interactive | ✅ built (3.5c) | list items → Approve/Reject → append `{itemId,decision,reason,by,at}` (current decision reduced from the log) |
| `task-checklist` | interactive | ✅ built (3.5c) | checklist → check appends `{taskId,done,by,at}` (done-state reduced from the log) |
| `editable-grid`  | interactive | ⏳ (deferred) | inline-editable table — needs in-place mutation |
| `kanban-workflow`| interactive | ⏳ (deferred) | movable status tiles (writes status) — needs in-place mutation |
| `action-detail`  | interactive | ⏳ (deferred) | record detail + governed actions — the 3.5d DSL `functions[]` now EXIST; wire the renderer in Phase 4 |

### Sandboxed custom block (security-critical)
`CustomBlockRenderer` renders the author's html/css/js inside `<iframe srcdoc>` with
`sandbox="allow-scripts"` and **NO `allow-same-origin`** → a UNIQUE NULL origin. The frame has
ZERO access to the OS session cookie, the parent DOM, or the OS `/api/*` routes as the user. Any
governed data is fetched in the PARENT (as the viewer, via the SDK) and inlined READ-ONLY as a
frozen `window.__DATA__`; the frame cannot call back. The srcdoc is assembled by the pure,
unit-tested `buildSandboxSrcdoc({html,css,js,data})` (escapes `<script>`-breakout sequences, adds a
strict CSP `<meta>`, `connect-src 'none'`). Guarantee: custom JS can never act as the user or
exfiltrate.

Invariants enforced by validation (author-time, on `set_app_spec`):
- `source.datasetId` EXISTS (peek the dataset store — kills false-"deleted") and is GRANTED to the app (else offer to grant); warn if Personal owner-only (unreadable by other users → promote-to-Domain).
- every `columns[].field` / `keyField` exists in the dataset's real schema.
- `metric.metricId` exists + granted.
- section ids unique; roleGate is a valid ladder rung.
Validation errors are typed `{path, reason, fix}` over a TINY grammar → trivially self-correcting (no TS-against-vendored-API fight).

## Renderer (`<AppSpecRenderer spec=… />`) — ONE OS-owned component
- Takes the resolved identity dependency-INJECTED (not a global `useIdentity`); gates TABS with `roleAtLeast(role, roleGate)` (advisory hide/lock; real enforcement stays at the data layer).
- Renders each tab body — a pattern renderer or the sandboxed custom block — with the vendored `@sovereign-os/ui` primitives; fetches via the same governed `os` SDK (`datasets.query`/`records.*`) — SAME governed path, same OPA/DLS.
- Maps columns by field NAME from the live `QueryResult`; formats cells per `format`; applies filter/sort/search/pagination generically (shared pure render-logic).
- Applies `theme.css` SCOPED under the app-root class so it can't leak into the OS chrome.
- Tested once, thoroughly → every declarative app inherits correct behavior.

## Serving — same-origin (REDESIGN-D, now default for declarative)
OS route `/{app}/<slug>` (or `/apps/<slug>`) renders `<AppSpecRenderer spec={loadSpec(slug)} />` under the user's EXISTING OS session, from the durable spec store. No per-app image/pod/CI/registry, no cross-origin: the cookie-domain/CORS/"builds-but-no-data" class cannot occur. Only ejected apps get pods.

**Grant-scope follow-up (Phase-4/hardening — `TODO(appspec-grant-scope)`):** the same-origin render runs AS the viewer and applies canView + RLS, but NOT the stricter app-grant INTERSECTION (`checkAppGrant`, audit F2) that fires only for cross-ORIGIN app requests carrying the app slug. So a SHARED spec app currently shows a viewer everything THEY can see among its sources, not a grant-narrowed subset — a minor gap (more-permissive, never less). Fix later: carry the app slug into the same-origin data reads so `checkAppGrant` applies here too. Not built in Phase 3.

## Context & capabilities (what a tab may read / write / use)
The six grantable context types in Choose Context: **Data · Metrics · Files · Knowledge · Agents · Connections.**
- **Agents = how intelligence enters an app.** Apps NEVER call the raw LLM. Build an agent in the Agents tab (governed, versioned, EVALUATED, role-gated, Langfuse-traced, cost-capped, runs as the user with its own ⊆ grants), grant it, invoke at runtime (a "Run agent" action). Deterministic logic → the DSL `functions[]` (3.5c); intelligent/generative logic → an agent.
- **Connections = mediated, never raw creds.** An app uses a connection only through a governed capability: external READS via a governed dataset (federation/adopt), external ACTIONS via an agent or the envelope-gated operational action surface. The app never holds credentials.
- **Per-tab I/O is explicit + derived** (never hand-declared, so it can't drift): every tab surfaces **reads** (data/metrics/files/knowledge) · **writes** (records/dataset) · **uses** (agents/connections), shown as a tab badge + in `describeApp` ("How this app works"). These are the precise app→artifact lineage edges (demote/delete of a source warns the exact tabs). *(3.5b: `describeApp` now derives `reads`/`writes`/`uses`/`serves` per tab PURELY from the pattern kind + config — every dataset/metric source across cards, landing sub-blocks and custom-block injected data is enumerated + deduped; view patterns write nothing, interactive patterns write `records`; `uses` is reserved-empty until patterns reference agents/connections.)*
- **Tab ↔ story linkage.** `Tab.stories: StoryRef[]` (`{ epicId, storyId }`, optional + additive) — each tab links to one or more epics/user-stories (MANY-TO-MANY: a story→several tabs, a tab→several stories), validated against the app's designed `epics`/stories on the `App` record (unknown epic/story → a typed issue). This is the Design-Epics→Build bridge. *(Built 3.5b.)*

## Choose Context (transparent: use existing + create new) — BUILT 4b
The six grantable types (**Data · Metrics · Files · Knowledge · Agents · Connections**), per type TWO
clearly-labelled actions (fixes the old intransparency):
- **Use existing** ("Already available to this app" + "＋ Add existing") — pick governed artifacts you're
  entitled to, grant to the app.
- **Create new** — a fresh, possibly-EMPTY dataset/file/knowledge, created in the **`App «App Name»`** folder
  under that context tab, granted to the app, appearing cleanly in the normal tab to fill later. Metrics point
  to the Data tab (a metric is a measure on a dataset — no standalone create). Agents deep-link to the Agents
  tab, connections to the Connections tab (they have their own creators); the grant is added on selection. New
  context matches a scope readable by the app's audience (personal for a My app; a Builder promotes to Domain
  for a shared app — governance gates apply; the 0.6.115 personal-in-shared warning stays). The folder-name
  derivation + the create-in-App-folder + grant orchestration live in the testable server helper
  `context-provision.ts` (`appContextFolder(appName)`, `createAndGrant(app, type, input, user)`), fail-soft +
  governed. The **Agents grant** is the sixth type — an additive `App.grants.agents:[{id,access}]` list (kept
  SEPARATE from the OS-wide 5-kind `ContextGrants` primitive so legacy apps + the Agents builder are unaffected).

## Authoring
- `set_app_spec(appId, spec)` / `add_tab(appId, tab)` — governed MCP + Build-stage tools; validate as above; on success the spec IS the app, served instantly (no build latency). Spec is a normal git-backed, versioned, audited artifact with the full lifecycle (My→Domain→Company promote, versioning, Marketplace, audit).
- Build stage UI: **COMPOSE, not author** — pick a cookbook pattern → map governed data (fields auto-offered from the real schema) → assign the tab to its story(ies). LOW VARIANCE for the LLM: it selects + fills slots, never writes code. Advanced Settings: the app theme CSS + the (builder-gated) custom HTML/CSS/JS block.
- `eject_to_code(appId)` — the RARE, builder-gated escape (likely deferred out of the cohort): prints the equivalent TSX + switches to the image/pod path (0.6.113–115 hardening as its net). Declarative is THE way; eject is a quiet advanced exit.

## Migration
Zero forced. Existing apps stay on the hardened image/TSX path; new apps default to declarative.

## Phases (each independently testable; 1–2 are the robustness core)
1. ✅ **Schema + validator + pure logic** — the AppSpec grammar, author-time validators (dataset/column/metric/grant/personal-warning) reusing store peeks, and the pure table/filter/format/column-map helpers. No DOM. Unit-tested.
2. ✅ **`<AppSpecRenderer>`** against vendored UI + governed fetch.
3. ✅ **Same-origin serving route** + durable spec loader.
3.5a ✅ **Tab-pattern cookbook engine** — v2 tabs·patterns·custom grammar; the pattern registry (all 18 ids, categorised); the **4 flagship** renderers (`records-table`, `detail`, `status-board`, `intake-wizard`); the **sandboxed custom html/css/js block** (null-origin iframe + pure `buildSandboxSrcdoc`); **app-wide theme CSS** (scoped); and the pure `describeApp` legibility surface. Unit-tested; JSX covered by tsc + build.
3.5b ✅ **Remaining VIEW patterns** (`master-detail`, `kpi-overview`, `chart-explorer`, `card-gallery`, `timeline`, `calendar`, `landing`) — real `parseConfig`/`summarize` + a renderer each (ECharts reused from dashboards, no new dependency); each config semantically VALIDATED against the real dataset/metric (source granted + fields exist via `peekDatasetColumns`/`peekMetricExists`, typed `{path,reason,fix}`). Plus `Tab.stories` (tab↔story links, many-to-many, validated against the app's designed `epics`) + per-tab **reads/writes/uses/serves** in `describeApp` (derived purely from pattern + config). Unit-tested; JSX covered by tsc + build.
3.5c ✅ **INTERACTIVE (append) patterns** (`form`, `assignment`, `approval-queue`, `task-checklist`) — governed **`os.records.add`** writes + advisory role gates. **The write door is APPEND-ONLY:** the vendored SDK `records` surface exposes `list/get/add/export` — there is NO `update`/`delete`. So every interactive pattern is designed around appending a NEW record to the app's own `os.records` log; state that feels mutable (an item's current decision, a task's done-flag) is DERIVED by REDUCING the log (latest append per key wins — pure, unit-tested reducers in `records-reduce.ts`). Writes are envelope-gated: a governed `Forbidden` is surfaced verbatim and a non-`live-app` (demo-seed) result is labelled illustrative — success is NEVER faked. Pure logic (`records-reduce.ts` reducers, `interactive-logic.ts` coercion/classification, `interactive-logic-select.ts` grid→options) is unit-tested; the four renderers (`FormRenderer`, `AssignmentRenderer`, `ApprovalQueueRenderer`, `TaskChecklistRenderer`) are covered by tsc + build. **The 3 remaining interactive ids (`editable-grid`, `kanban-workflow`, `action-detail`) are DEFERRED** — they want IN-PLACE record mutation (editable-grid, kanban) or DSL functions (action-detail), neither of which the append-only `records.add` door nor the not-yet-built 3.5d `functions[]` cleanly support; they stay valid, categorised ids rendering the honest "coming soon" placeholder until either an `os.records.update` capability or the 3.5d DSL lands.
3.5d ✅ **Backend functions** (`functions[]`) — the governed query/expression DSL (deterministic logic; intelligence stays in agents). Each function is NAMED + DESCRIBED and is exactly ONE of two SAFE kinds — NO arbitrary code, NO eval, ever:
  - **aggregate** `{ source:{datasetId}, op:'count'|'sum'|'avg'|'min'|'max', field?, filters?:[{field, op:'eq'|'neq'|'gt'|'lt'|'gte'|'lte', value}] }` → a number. Executed at runtime by querying the GRANTED dataset via the governed `os` client and REDUCING the returned rows with a PURE reducer (`functions-eval.ts`); `count` needs no field, numeric ops require one. Non-numeric/blank cells are ignored (never coerced), so a sum/avg stays honest; an empty reduce → null.
  - **expression** `{ expr }` → a number or boolean over a TINY safe grammar (`expr.ts`): number/string/bool literals, references to OTHER function ids (`fn.<id>`), arithmetic `+ - * /`, comparison `> < >= <= == !=`, boolean `&& || !` (short-circuit), ternary `a ? b : c`. Parsed to an AST and evaluated by a PURE tree-walker — **never** `eval`/`new Function`, no property access, no globals. Safety by construction: unknown ref → null, division-by-zero → null, type-mismatch → null; a DEPTH cap (`MAX_DEPTH`) + a token/complexity cap (`MAX_TOKENS`) reject a pathological expression at PARSE time so it can't blow the stack.
  - Runtime `evaluateFunctions(functions, os)` resolves aggregates (each distinct dataset queried ONCE — memoized) then evaluates expressions in DAG order, DETECTING + rejecting cycles (a cyclic function → null). Returns `Record<functionId, number|boolean|null>`; never throws, never fakes (a failed/forbidden read → null).
  - Author-time `validate.ts` proves: aggregate source granted + `field`/filter fields exist (issue lists the real columns) + numeric-op needs a field; expression parses + every `fn.<id>` ref resolves + no cycles; ids unique across functions. `describe.ts` adds a **functions** section (each function's name/description/what + what it READS — its dataset, or the functions it depends on) for "How this app works".
  - **First consumer:** `kpi-overview` (and the `landing` KPI block) — a card may be `{ label, function:{ functionId } }` alongside metric/dataset cards; `KpiCards` calls `evaluateFunctions` ONCE per grid and renders each card's evaluated value (numbers compact, booleans Yes/No, null `—`; honest per-card loading/error). The card's `functionId` must name a declared function (validated).
  - **Still deferred:** `editable-grid` + `kanban-workflow` want IN-PLACE record mutation (`records.update`), which the append-only `records.add` door still doesn't offer — they stay coming-soon. `action-detail` can NOW consume functions (a record detail + governed actions whose enable/value comes from `functions[]`) — to be WIRED as a rendered pattern in Phase 4.
4a ✅ **Build-stage COMPOSE UI** — the pattern-first, NO-CODE authoring surface a USER (not just MCP)
   drives in the Software tab. When an app is declarative (`serveMode:'spec'`) the Build stage renders
   `<AppSpecComposer>` instead of the code-build chat (branch in `SoftwareBuilder`; a thin
   `SpecBuildStage` resolves granted dataset/metric NAMES from `/api/context/available` + flattens the
   app's stories, then hands them to the pure composer). Three panes:
   - **Tab list** (left) — add / rename / reorder / remove; each row shows its pattern + a reads/writes badge.
   - **Tab editor** (center) — a **pattern picker** (VIEW vs INTERACTIVE shelves; the *implemented* ids
     from `IMPLEMENTED_PATTERNS`, unimplemented ones greyed "soon") → a **selection-only config form**:
     pick a granted dataset from a dropdown, tick real **columns/fields** from the FETCHED schema
     (`/api/data/datasets/[id]` → gold/base columns; cached per id) — NEVER a free-text field name —
     set labels/formats/filters/booleans from selects; plus a tab **story multiselect** (→ `tab.stories`)
     and an advisory role gate.
   - **Live preview + legibility** (right) — the real `<AppSpecRenderer>` on a same-origin `os` client +
     current identity, and a "How this app works" summary from `describeApp`.
   Save runs the composed spec through `parseAppSpec` + `validateAppSpec` via a NEW internal
   `POST /api/apps/[id]/spec` (calls `setAppSpec` AS the signed-in user — the SAME governed door as MCP,
   no MCP dependency); typed `{path,reason,fix}` issues are located to the owning tab/slot and shown
   INLINE. Success → the spec is live at `/apps/<slug>` immediately. New-app UI adds a **"Declarative app
   (no-code · recommended)"** vs **"Coded app (advanced)"** choice (defaults to declarative →
   `createApp({kind:'spec'})`). Pure logic (`compose-model.ts` state+reducers+`composeSpec`,
   `compose-fields.ts` per-pattern authoring slots + selection→config folding, `compose-issues.ts`
   issue-path → tab/slot mapping) is unit-tested (`compose.test.ts`, incl. a records-table+detail ROUND
   TRIP); JSX by tsc + build. **4a SCOPE:** the VIEW patterns reading ONE dataset + `records-table`
   filters + the single-source `form` get a rich selection editor; multi-dataset / metric-only / composed
   patterns (`assignment`, `chart-explorer`, `kpi-overview`, `landing`, `intake-wizard`, `approval-queue`,
   `task-checklist`) stay VALID + render an honest "configured in Advanced / MCP for now" note (their rich
   editors are 4b/4c). NOT built in 4a: Choose-Context six-types (Data·Metrics·Files·Knowledge·**Agents·
   Connections**; use-existing + create-new in `App «Name»` folder), the "Run agent" / `action-detail`
   action wiring, and the Advanced-Settings custom-block / theme editor.
4b ✅ **Choose-Context six types** (use-existing + create-new). The Choose-Context stage is redesigned
   so it is OBVIOUSLY about BOTH picking existing AND adding new context, per type — **Data · Metrics ·
   Files · Knowledge · Agents · Connections** — each a section with two unmistakable modes:
   - **Already available to this app** + **＋ Add existing** — the entitled-artifacts picker (the existing
     `/api/context/available` feed + the folder-OR-item / flat grant UI), multiselect → grant via
     `patchAppDesign`. Shows the current grants + the 0.6.115 personal-in-shared warning.
   - **＋ Create new** — Data/Files/Knowledge create a FRESH, possibly-EMPTY governed artifact in the
     **`App «Name»`** folder under that tab (via `POST /api/apps/[id]/context-provision` → the server helper
     `context-provision.ts`: `appContextFolder(appName)` + `createAndGrant(app, type, input, user)`), placed at
     a personal scope + granted, with a clear "created in App «name» — open to fill it" pointer. Metrics point
     to the Data tab (a metric is a measure on a dataset). Agents/Connections deep-link into their own tab
     builders (they have their own creators); the grant is added on selection. Everything governed + fail-soft
     (respects the caller's create rights + `patchAppDesign` edit-scope; folder placement best-effort).
   The **AGENTS grant** (the sixth type; the model had 5) is added as an additive `App.grants.agents:
   [{id,access}]` list — SEPARATE from the OS-wide `ContextGrants` primitive (which the Agents builder also
   uses) so legacy apps load unchanged (`[]` default in `hydrateAppDoc`). It is wired through `patchAppDesign`
   and compiled into the app's OPA capability profile (`agentToolsFromGrants` → `run_agent_system` +
   `list_agent_systems`), so a granted agent is RECORDED as available to the app. Pure logic
   (`app-agent-grants.ts` round-trip, `context-provision.ts` folder-derivation + create-and-grant,
   `choose-context-model.ts` six-type descriptor) is unit-tested; JSX by tsc + build. **NOT built in 4b
   (→ 4c):** the runtime "Run agent" INVOCATION, the deferred multi-source/metric/composed pattern editors,
   and the Advanced custom-block/theme editor.
4c ✅ **Rich compose editors for ALL implemented patterns + Advanced (theme + custom block).** Every
   implemented pattern is now authorable by SELECTION alone in `<AppSpecComposer>` — `COMPOSE_DEFERRED`
   is empty. New selection-only editors:
   - **chart-explorer** — a granted **metric** picker + its dataset's real **dimensions**/**time
     dimension** (the metric id → its underlying dataset → the same cached schema, so no member is ever
     typed) + **granularity** + **chart type** from closed enums.
   - **card-gallery · timeline · calendar** — dataset + title/date/subtitle/description **field** selects
     (+ gallery search toggle), all ticked from the fetched schema.
   - **kpi-overview** — an add/remove **card list**; each card = **metric** | **dataset aggregate**
     (dataset + count/sum/avg + field) | **function** (a declared `functions[]` id), edited via a shared
     `KpiCardEditor` (source segmented control; exactly one source enforced).
   - **landing** — an ordered **block list** (markdown textarea | a reused KPI-card list | a table block =
     dataset + ticked columns) with reorder/remove.
   - **assignment** — item dataset + item-label field, assignee dataset + option-label field, and an
     optional extra-field builder.
   - **intake-wizard** — add/remove **steps**, each a name/label/type/required **field builder** (no
     dataset — writes to records).
   - **approval-queue · task-checklist** — a **source-choice** (the app's own `records` vs a granted
     dataset) + title/subtitle/assignee fields (record-mode fields are typed keys, dataset-mode are
     ticked columns) + a reason-required toggle.
   Plus the **function editor** (Advanced): add an **aggregate** (dataset + op + field) or an
   **expression** (a formula referencing `fn.<id>`, live-validated through the same `parseFunctions`
   parser the server uses) → a valid `functions[]` a KPI card can reference.
   **Advanced settings** (builder-gated `roleAtLeast(role,'builder')`, collapsed `<details>`): the app
   **theme CSS** (size-capped, scoped under the app root, reflected in the live preview) and a
   **sandboxed custom HTML/CSS/JS block** — any tab can become a `custom` body (three code fields +
   an optional read-only injected dataset), rendered through the existing null-origin
   `CustomBlockRenderer`; the UI states the SAFETY explicitly ("runs in a sandboxed frame with no OS
   access"). This is the ONLY place free-form code is allowed, and it is clearly gated + labelled.
   New pure logic: `compose-blocks.ts` (card/block/step/field/function list reducers + factories),
   `compose-fields.ts` (metric/enum/source-choice slots, `columnSourceDatasetId`, the new folders),
   `compose-model.ts` (custom-body + `functions[]` on the state; `stateFromSpec` now PRESERVES a
   custom-block tab + functions), `compose-issues.ts` (function-scope + custom-body issue paths) — all
   unit-tested (`compose.test.ts`, incl. a round-trip through `parseAppSpec`+`validateAppSpec` for every
   newly-editable pattern, the custom block, and the function editor). JSX by tsc + build.
   **NOT built (→ 4d):** the runtime **"Run agent" invocation** + the `action-detail` rendered pattern.
5. ⏳ **`eject_to_code`**.

4d ⏳ **Run-agent invocation + `action-detail`** — invoking a granted agent from a tab action and the
   record-detail-with-governed-actions pattern (consuming the 3.5d `functions[]`).

## Non-goals / honest limits
- Patterns are a closed cookbook; a layout no pattern expresses → a custom block (sandboxed) or eject. Grow the cookbook as needed.
- The custom block runs in a null-origin sandbox: it CANNOT call the OS, only read the parent-fetched `window.__DATA__` snapshot. That is the whole safety boundary — no callback path is offered.
- Declarative apps have no per-app pod/CI (that's the point); the pipeline pedagogy is available via eject.
