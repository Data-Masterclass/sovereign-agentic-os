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

The MCP tool sequence below is the same governed path the UI drives.

## How to build it

1. **Reuse check.** Call `list_software` to see what exists in your domain. Call `get_software` to inspect a specific app before forking or duplicating it.
2. **Create.** Call `create_software` with `name`, an optional `domain` and `template` (e.g. `nextjs-supabase`), and an optional `surface` — **declare the app's surface** as `ui` (serves a frontend), `api` (headless / tool surface), or `both`. A declared surface wins over auto-detection, so a UI app is never mislabelled as API; omit it to let the OS infer the surface from the code (an app can also declare `surface:` in its `app.yaml`). This creates a My-scope draft AND seeds the app's Forgejo repo with a **real build→push CI workflow** (plus the `REGISTRY_PASS` Actions secret). From here on, every push to `main` **auto-builds the app image** on the in-cluster Forgejo Actions runner and pushes the tag the app runner pulls — no manual build step. Use `get_software_status` to watch the build pipeline.
3. **Commit code.** Call `commit` with your code payload. A commit is a push to `main`, so it triggers the auto-build. Declare consumed dependencies in a `.app/` manifest file within the commit — list the dataset IDs, knowledge IDs, and connection IDs your app will use. Read your work back with `read_app_files` — the app's committed file tree, or one file's content when you pass a `path`. What you committed is what you read; iterate on the real code, never a guess.
4. **Wire dependencies by reference.** Call `use_data({ datasetId })`, `use_knowledge({ knowledgeId })`, and `use_connection({ connectionId })` to formally bind each dependency. The OS enforces that you can only wire assets you have read access to. Credentials are never copied into the app.
5. **Preview.** Call `start_preview` to run the app privately. The preview is sandboxed and visible only to you.
6. **Request deploy.** Call `request_deploy` to open a Builder review card. The app stays in preview until a Builder acts.
7. ⛔ **Builder decides.** A Builder or Admin calls `decide_deploy` to approve or reject. Approval moves the app to the declared target environment.
   At any point, `get_software_status` returns the ONE honest status card — preview/deploy state, the review decision + reviewer, release count and the build pipeline. URLs appear only when a runner actually serves them; a pending runner is stated, never papered over.
8. **Optional: close the loop.** Call `use_as_data` to register the app's output as a Bronze dataset, feeding the data tier.

Additional lifecycle tools: `promote` (scope promotion), `archive` (reversible soft-hide that retains data + lineage — an archived app can be **restored**, or hard-`delete`d), `delete` (hard delete — blocked if another asset depends on this one).

## What to consider

- **Wire deps before preview.** An app that references a connection ID not formally wired will fail at preview start with `bad_request`.
- **Dependency by reference only.** Never embed credentials or dataset row copies in committed code. The OS detects raw credential patterns and returns `bad_request`.
- **delete is lineage-blocked.** If another dataset, software, or metric depends on this app's output, `delete` returns `conflict`. Use `archive` instead.
- **Scope of deps constrains deploy scope.** An app wired to a My-scope connection cannot be deployed to Domain. Promote dependencies first.
- **`use_as_data` closes the spine.** The Bronze dataset created by `use_as_data` inherits the app's lineage, making the data-to-software-to-data chain fully traceable.

## Governance

| Step | Role required |
|---|---|
| `list_software`, `get_software`, `read_app_files`, `get_software_status` | Creator |
| `create_software`, `commit`, `use_data`, `use_knowledge`, `use_connection`, `start_preview`, `request_deploy`, `use_as_data`, `promote`, `archive` | Creator (own work) |
| ⛔ `decide_deploy` | Builder or Admin |
| `delete` | Creator (lineage permitting) |

OPA checks every dependency reference at wire time and at deploy time. Langfuse traces every production invocation.

**Worked example:**

```
list_software({ domain: "data-eng" })
→ [{ id: "sw_22A...", name: "invoice-loader", state: "deployed" }]
— a loader exists; create a separate transform app

create_software({ name: "invoice-transformer", domain: "data-eng", template: "nextjs-supabase", surface: "api" })
→ { id: "sw_33B...", surface: "api", state: "draft" }

commit({ id: "sw_33B...", files: { "main.py": "...", ".app/deps.yaml": "datasets: [ds_01J...]" } })
→ { committed: true }

use_data({ appId: "sw_33B...", datasetId: "ds_01J..." })
→ { wired: true }

start_preview({ id: "sw_33B..." })
→ { previewUrl: "https://preview.os/sw_33B...", state: "running" }

request_deploy({ id: "sw_33B...", environment: "shared" })
→ { reviewCardId: "rc_55D...", state: "pending_deploy" }
```

A Builder then calls `decide_deploy({ reviewCardId: "rc_55D...", decision: "approve" })`.
