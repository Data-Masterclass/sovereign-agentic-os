# Build spec — Software (canonical)

The one canonical spec the Software Delivery Team builds against. It has **two
byte-synced consumers**: it is injected into the internal team executor's system
preamble, and it is exposed over the MCP as the guide resource
`sovereign-os://guide/build-spec/software` (referenced from the
`build_and_ship_software` prompt). A drift test asserts all copies are identical.

> Phase 1 status: **build + commit + iterate is real** (real Forgejo commits).
> **Preview and live deploy are not yet available** — the in-cluster runner ships
> in the next release. Never claim a working preview or live URL. The governed
> review gate (`request_deploy` → Builder `decide_deploy`) is real; only the
> served workload is pending.

## 1. What you are building on

Next.js (App Router) + Supabase (Postgres, Auth, Storage), living in sovereign
Git (Forgejo) inside the tenant boundary. Nothing leaves the tenant: all models
and tools are in-tenant and governed. Every tool call runs **as the signed-in
user** — OPA-authorized, DLS-filtered, Langfuse-audited. Consume granted
resources **by reference** (`use_*`), never a raw credential.

## 2. The template (`nextjs-supabase`)

`create_software` seeds this tree into the app's Forgejo repo. Each file has a job:

| File | Purpose |
|---|---|
| `package.json` | `next dev` / `next build` / `next start`; deps: next, react, `@supabase/supabase-js`. |
| `supabase/migrations/0001_init.sql` | Schema + **Row-Level Security** (every row scoped to `auth.uid()`). Migrations must be **idempotent** (`create table if not exists`, `create policy` guarded). |
| `Dockerfile` | Container build (node:22-alpine, serves on `:8080`). |
| `.forgejo/workflows/ci.yml` | CI on push to `main` (build → image). |
| `manifests/app.yaml` | The Kubernetes Deployment manifest (image, port `8080`). |
| `app.yaml` | **The metadata convention** — `name`, `owner`, `connections`, `data`, `knowledge`. Re-parsed on **every commit** to drive the app page + OPA profile. Keep it truthful. |
| `openapi.yaml` | Drives the app's **auto-generated MCP tools**. Keep it in sync with your routes. |
| `.app/decisions.md` | Append every design decision you make (versioned in git). |

Conventions:

- **Commit complete, runnable files — never placeholders.** A commit is a
  **changeset merged over the current tree**, so a partial commit must not make
  untouched `app.yaml` / `openapi.yaml` / `.app/` files disappear.
- Keep `app.yaml` and `openapi.yaml` **truthful** — they compile into the app's
  MCP tools + OPA profile on every commit.
- Log decisions in `.app/decisions.md`.

## 3. The governed tool sequence (the golden path)

```
create_software(name, template: "nextjs-supabase", domain?)   // once
  → commit(appId, files[], message)                           // complete files
  → use_data / use_knowledge / use_connection(appId, ref)     // deps BY REFERENCE
  → start_preview(appId)          // Phase 1: reports PENDING (no served URL yet)
  → request_deploy(appId)         // opens the Builder review card
  ⛔ decide_deploy(cardId, "approve")   // Builder/Admin ONLY — never self-approve
```

Worked JSON:

```jsonc
create_software({ "name": "Renewals Tracker", "template": "nextjs-supabase" })
// → { "id": "app_ab12cd3", "slug": "renewals-tracker", "deploy": { "state": "building" }, ... }

commit({ "appId": "app_ab12cd3", "message": "scaffold renewals table + list view",
         "files": [ { "path": "app/page.tsx", "content": "..." },
                    { "path": "supabase/migrations/0002_status.sql", "content": "..." } ] })
// → { "app": {...}, "step": { "ok": true, "mode": "live" } }

use_data({ "appId": "app_ab12cd3", "ref": "ds_01J...", "label": "Accounts (gold)" })
// → the dependency is recorded as a reference (no credential copied)

start_preview({ "appId": "app_ab12cd3" })
// → { ..., "deploy": { "state": "preview", "previewUrl": null } }
//   Preview runner pending — do NOT claim a working URL.

request_deploy({ "appId": "app_ab12cd3" })
// → { "kind": "review", "card": { "id": "rev_...", "reason": "first-deploy", "decision": "pending" } }
```

**Structured tool errors** come back as `{ "error": { "code", "reason", "hint" } }`:

| code | meaning | what to do |
|---|---|---|
| `forbidden` | role/domain gate (e.g. a creator called `decide_deploy`) | hand off to a Builder, or keep it Personal |
| `not_found` | unknown id | call `list_software` / `get_software` first |
| `conflict` | already in that state | idempotent — no further action |
| `bad_request` | bad args / raw credential detected | check the inputSchema; wire deps by reference |

## 4. Governance rules

- The **creator** builds, previews, and `request_deploy`s. **`decide_deploy` is
  Builder/Admin only and can never be self-approved.**
- The **first deploy** and any **scope-broadening** change always open a review
  card; routine in-envelope updates auto-deploy.
- A **failing security scan** (leaked secret / high finding) **blocks approval**.
- Resources arrive **by reference** via `use_connection` / `use_data` /
  `use_knowledge` — raw secrets in committed code are rejected (`bad_request`).
- Models are **€-budgeted**; a budget-exhausted turn reports "weekly budget
  reached", never a fake success.

## 5. Elicitation — the question set

Before building, confirm the brief answers these. **Ask only what it does not
already answer** (max 5, numbered, each answerable in one line). Never ask a
fixed quota of questions.

1. **Purpose** — what problem does the app solve?
2. **Users** — who signs in and uses it?
3. **Data model** — the core entities/tables and key fields.
4. **Key screens** — the routes/views that matter.
5. **Integrations** — which governed data / knowledge / connections it consumes.
6. **Deploy target** — Personal preview, or a Shared domain go-live?

If the brief answers all of these, skip straight to the plan.

## 6. Pre-deploy checklist

- [ ] The plan the user approved is satisfied.
- [ ] Migrations are **idempotent** and RLS scopes every table.
- [ ] **No secret literals** in committed files (scan will block otherwise).
- [ ] `openapi.yaml` matches the routes; `app.yaml` lists real consumed deps.
- [ ] Decisions logged in `.app/decisions.md`.
- [ ] (Phase 2) preview opens — currently pending the in-cluster runner.

## 7. Worked example — a small renewals tracker

1. **Brief (vague):** "a renewals tracker." → ask the missing questions:
   *who are the users? what fields per renewal? any status filter? Personal or Shared?*
2. **Answers → plan (card the user approves):**
   routes `/` (list) + `/new`; table `renewals(account, product, amount, renews_on, status)`;
   files `app/page.tsx`, `app/new/page.tsx`, `supabase/migrations/0002_status.sql`; no external deps.
3. **Build:** `create_software` once, then `commit` the complete files.
4. **Feedback:** "rename the heading, add a status filter" → a **diff commit** of the
   changed files only (not a re-scaffold).
5. **Ship:** "ship it" → `request_deploy` → a Builder review card. A Builder
   `decide_deploy("approve")` records the go-live. (Served workload: next release.)
