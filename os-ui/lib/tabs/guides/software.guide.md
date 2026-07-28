# Software — golden path

## What this is

The Software tab is where apps and services are built, deployed, and governed. Software is the most dependency-rich surface in the OS: it can consume governed datasets, published knowledge, and promoted connections — all by reference, never by copying. Deployed software runs as the signed-in user under OPA policy. Optionally, a running app can export its output back to the Bronze data tier via `use_as_data`, closing the cross-tab spine loop.

## Guided flow (UI) — five stages, each one function

1. **Define** — name it, **pick a template** (Application = the Sovereign standard app: OS sign-in + Admin/user-directory + settings + multi-tenant, and the DEFAULT; Website; APIs only; Empty — locked at creation), state its purpose, and grant governed context. The whole Define context (template + name/description + purpose) is carried into every later spec-draft and code-generation prompt, so features are grounded in what the app is.
2. **Design** — the SPECIFICATION. Read-first, one epic at a time (prev/next), with an Edit toggle. Per user story, three lists: **Features**, **Non-functional requirements**, **Rules** (stories are expandable spec rows). Assistant on the left, epic detail on the right. Complete when every story has a spec.
3. **Build** — EXECUTION. The left tree is Epics › Stories › Features/NFRs/Rules; tick the features to build next (a **selection checkbox**, capped at 8 features per batch — distinct from the green **done ✓** status badge), then press the one Build button. The right panel always shows the selected item's spec and, after a build, ticks each item honestly against what shipped (pending if unverifiable, never fake-ticked). Feedback goes to the build chat at the bottom.
4. **Test** — one "Verify & Improve" button LLM-verifies each built story against its Design spec (PASS/FAIL per item, grounded in the committed code) and drafts concrete improvements for shortfalls; the LIVE-POD view (real preview app + provision control) stays here. Improvements become pending Build to-dos — a missed spec item is a **rebuild** (standard model); feedback that changes the requirement is routed to **Design** first.
5. **Publish** — request go-live (a Builder deploy review), then run the live app, call its governed MCP tools, and climb the promotion ladder.

**Model tiers (cost policy):** Define — no LLM. Design — **reasoning** (all planning + the full spec). Build — **standard only** (code generation from the finalized spec, deterministic sequencing, never escalated to reasoning). Test — **reasoning** (verify built code vs spec → the fix loop rebuilds on standard). Publish — no LLM. Each stage shows an honest tier badge.

The MCP tool sequence below is the same governed path the UI drives — **the staged Define → Design → Build → Test → Publish flow is the default; direct `commit` is the deliberate exception (Developer mode).**

## How to build it (the staged governed flow — default path)

An external agent (Claude / Codex) walks the IDENTICAL five governed stages the UI does. Each stage tool reuses the same governed server function the UI calls — so the design-before-build gate, model tiers, role gates, folder structure and audit all apply automatically.

0. **Reuse check.** Call `list_software` to see what exists in your domain. Call `get_software` to inspect a specific app (its epic/story/spec tree + grants + lifecycle) before forking or duplicating it.
1. **Define — `create_software`.** Pass `name`, an optional `domain` and `template` (`sovereign-app` = the default Application; `website`; `api-service`; `empty`), an optional `surface` (`ui` | `api` | `both` — a declaration wins over auto-detection, so a UI app is never mislabelled as API), and an optional `purpose`. This creates a My-scope draft AND seeds the app's Forgejo repo with a **real build→push CI workflow** (plus the `REGISTRY_PASS` Actions secret): every push to `main` **auto-builds the image** — no manual build step. Watch the pipeline with `get_software_status`.
2. **Design — `design_software`.** Author the SPECIFICATION tree: `purpose`, `epics` (each with user stories), and per-story `spec` (three lists: **features**, **non-functional requirements**, **rules**) plus governed context `grants`. This is the reasoning-tier stage; a story must have a spec here before it can be built.
3. **Build — `build_software`.** Build a SPECIFIC unit — the whole app, one `epic`, or one `story` (pass `target`) — from its finalized spec. It **enforces the design-before-build gate** (refuses stories with no spec, naming them), pins the **standard** tier, and returns the governed build directive + Define context + the target's spec + the code-structure convention (write each story under `epics/<epic>/<story>/`; `app/` stays thin router entrypoints) + the current committed files and honest built-vs-pending progress. Author the code, then `commit` it, then mark completed stories done via `design_software` (set the story `status` to `done`). Read code back any time with `read_app_files`.
4. **Test — `verify_software`.** Verify a built unit against its spec across the **five dimensions** (Functionality · User Experience · Code Structure · Security · Documentation). It returns the governed test directive + the committed code to verify against (read-only, reasoning tier). Report PASS/FAIL per dimension and pass any shortfalls as `findings` — each becomes a dimension-tagged **refinement** via the same refinement model the UI uses (a missed-spec item is a rebuild; a requirement change routes back to Design first). Feed refinements back into Build.
5. **Publish.** `start_preview` runs the app privately (no review). `request_deploy` opens a Builder review card (security scan + envelope + diff). ⛔ A Builder/Admin then calls `decide_deploy` to approve/reject (a non-Builder gets a 403; approval requires a passing scan). `promote` climbs the tier ladder. `get_software_status` returns the ONE honest status card at any point — URLs appear only when a runner actually serves them.

**Wire dependencies by reference** (any stage): `use_data`, `use_knowledge`, `use_connection` formally bind a granted asset — you can only wire what you have read access to; credentials are never copied into the app. **Close the loop:** `use_as_data` registers the app's output as a Bronze dataset. Lifecycle: `promote`, `archive` (reversible soft-hide, restorable), `delete` (hard delete — lineage-blocked).

## Developer mode — direct `commit` (the escape hatch, NOT the default)

`commit` writes files DIRECTLY to the app folders, **bypassing the staged Design → Build → Test governance and the design-before-build gate**. It is role-gated to **Builder/Admin** — a Creator cannot use it to bypass the governed stages. Reach for it only as a deliberate exception (e.g. a low-level fix outside the epic/story model); the normal flow is `design_software` → `build_software` → `verify_software`. A commit is a push to `main`, so it triggers the auto-build; declare consumed dependencies in a `.app/` manifest within the commit.

## What to consider

- **Wire deps before preview.** An app that references a connection ID not formally wired will fail at preview start with `bad_request`.
- **Dependency by reference only.** Never embed credentials or dataset row copies in committed code. The OS detects raw credential patterns and returns `bad_request`.
- **delete is lineage-blocked.** If another dataset, software, or metric depends on this app's output, `delete` returns `conflict`. Use `archive` instead.
- **Scope of deps constrains deploy scope.** An app wired to a My-scope connection cannot be deployed to Domain. Promote dependencies first.
- **`use_as_data` closes the spine.** The Bronze dataset created by `use_as_data` inherits the app's lineage, making the data-to-software-to-data chain fully traceable.

## Governance

| Step | Role required |
|---|---|
| `list_software`, `get_software`, `read_app_files`, `get_software_status`, `build_software`, `verify_software` | Creator |
| `create_software`, `design_software`, `use_data`, `use_knowledge`, `use_connection`, `start_preview`, `request_deploy`, `use_as_data`, `archive` | Creator (own work) |
| ⛔ `decide_deploy`, `promote` | Builder or Admin |
| ⛔ `commit` (Developer mode — direct file write, bypasses the staged governance) | Builder or Admin |
| `delete` | Creator (lineage permitting) |

`build_software` and `verify_software` are read-only planning tools — they hand back the governed build/test directive + committed code and enforce the design-before-build gate; the actual writes still flow through `commit` (Developer mode) or, for spec/status, `design_software`.

OPA checks every dependency reference at wire time and at deploy time. Langfuse traces every production invocation.

**Worked example:**

```
list_software({ domain: "data-eng" })
→ [{ id: "sw_22A...", name: "invoice-loader", state: "deployed" }]
— a loader exists; create a separate transform app

create_software({ name: "invoice-transformer", domain: "data-eng", template: "api-service", surface: "api", purpose: "Transform loaded invoices into the gold model" })
→ { id: "sw_33B...", surface: "api", state: "draft" }        # DEFINE

design_software({ appId: "sw_33B...", epics: [{ id: "epic_1", title: "Transform", stories: [
  { id: "story_1", title: "Normalize amounts", asA: "analyst", iWant: "amounts in EUR", soThat: "reports reconcile",
    spec: { features: ["Convert currency"], nfrs: ["<500ms/1k rows"], rules: ["No raw credentials in code"] } }] }] })
→ { epics: [...] }                                            # DESIGN (spec authored)

build_software({ appId: "sw_33B...", target: { kind: "story", epicId: "epic_1", storyId: "story_1" } })
→ { stage: "build", gate: "passed", tier: "standard", directive: "…", progress: { itemsBuilt: 0, itemsTotal: 3 }, code: {…} }
# author the code from the directive, then:
commit({ appId: "sw_33B...", files: [{ path: "src/epics/epic_1/story_1/Normalize.tsx", content: "…" }, { path: ".app/deps.yaml", content: "datasets: [ds_01J...]" }] })   # Developer mode — Builder+
design_software({ appId: "sw_33B...", epics: [/* story_1 with status: "done" */] })

verify_software({ appId: "sw_33B...", target: { kind: "story", epicId: "epic_1", storyId: "story_1" },
  findings: [{ storyId: "story_1", note: "Handle empty input", dimension: "ux" }] })
→ { stage: "test", tier: "reasoning", directive: "…", refinements: [{ kind: "rebuild", dimension: "ux", … }] }   # TEST

use_data({ appId: "sw_33B...", ref: "ds_01J..." })
start_preview({ appId: "sw_33B..." })
request_deploy({ appId: "sw_33B..." })
→ { kind: "review", card: { id: "rc_55D..." } }              # PUBLISH (Builder review)
```

A Builder then calls `decide_deploy({ cardId: "rc_55D...", decision: "approve" })`.
