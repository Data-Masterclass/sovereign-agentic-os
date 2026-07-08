# Software — golden path

## What this is

The Software tab is where apps and services are built, deployed, and governed. Software is the most dependency-rich surface in the OS: it can consume governed datasets, published knowledge, and promoted connections — all by reference, never by copying. Deployed software runs as the signed-in user under OPA policy. Optionally, a running app can export its output back to the Bronze data tier via `use_as_data`, closing the cross-tab spine loop.

## How to build it

1. **Reuse check.** Call `list_software` to see what exists in your domain. Call `get_software` to inspect a specific app before forking or duplicating it.
2. **Create.** Call `create_software` with `name`, `domain`, and `type` (e.g. `app`, `service`, `pipeline`). This creates a Personal draft AND seeds the app's Forgejo repo with a **real build→push CI workflow** (plus the `REGISTRY_PASS` Actions secret). From here on, every push to `main` **auto-builds the app image** on the in-cluster Forgejo Actions runner and pushes the tag the app runner pulls — no manual build step. Use `get_software_status` to watch the build pipeline.
3. **Commit code.** Call `commit` with your code payload. A commit is a push to `main`, so it triggers the auto-build. Declare consumed dependencies in a `.app/` manifest file within the commit — list the dataset IDs, knowledge IDs, and connection IDs your app will use. Read your work back with `read_app_files` — the app's committed file tree, or one file's content when you pass a `path`. What you committed is what you read; iterate on the real code, never a guess.
4. **Wire dependencies by reference.** Call `use_data({ datasetId })`, `use_knowledge({ knowledgeId })`, and `use_connection({ connectionId })` to formally bind each dependency. The OS enforces that you can only wire assets you have read access to. Credentials are never copied into the app.
5. **Preview.** Call `start_preview` to run the app privately. The preview is sandboxed and visible only to you.
6. **Request deploy.** Call `request_deploy` to open a Builder review card. The app stays in preview until a Builder acts.
7. ⛔ **Builder decides.** A Builder or Admin calls `decide_deploy` to approve or reject. Approval moves the app to the declared target environment.
   At any point, `get_software_status` returns the ONE honest status card — preview/deploy state, the review decision + reviewer, release count and the build pipeline. URLs appear only when a runner actually serves them; a pending runner is stated, never papered over.
8. **Optional: close the loop.** Call `use_as_data` to register the app's output as a Bronze dataset, feeding the data tier.

Additional lifecycle tools: `promote` (tier promotion), `archive` (soft-delete, preserves lineage), `delete` (hard delete — blocked if another asset depends on this one).

## What to consider

- **Wire deps before preview.** An app that references a connection ID not formally wired will fail at preview start with `bad_request`.
- **Dependency by reference only.** Never embed credentials or dataset row copies in committed code. The OS detects raw credential patterns and returns `bad_request`.
- **delete is lineage-blocked.** If another dataset, software, or metric depends on this app's output, `delete` returns `conflict`. Use `archive` instead.
- **Tier of deps constrains deploy tier.** An app wired to a Personal connection cannot be deployed to Shared. Promote dependencies first.
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

create_software({ name: "invoice-transformer", domain: "data-eng", type: "pipeline" })
→ { id: "sw_33B...", state: "draft" }

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
