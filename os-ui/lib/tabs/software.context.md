# Software tab — build context

**Purpose:** Define → design → build → test → governed-publish real apps that live in sovereign Git (Forgejo) and ship Forgejo Actions → Harbor → Argo CD to a live subdomain.

**Guided flow — five stages, each ONE function (UI):**
- **Define** — name, purpose, **template pick** (Application = the `sovereign-app` scaffold: OS sign-in + Admin + user directory + multi-tenant, and the DEFAULT; Website; APIs only; Empty), and governed context grants. Template locks at creation. The full Define context (template + name/description + purpose) is threaded into every downstream Design spec-draft and Build code-generation prompt — features are grounded in what the app IS.
- **Design** — the SPECIFICATION, read-first, one epic at a time (prev/next). Per user story, three editable lists: **Features**, **Non-functional requirements**, **Rules**. Assistant on the left, epic detail on the right; stories are expandable spec rows; an Edit toggle flips read↔edit. Done when every story has a spec.
- **Build** — EXECUTION. Left tree = Epics › Stories › Features/NFRs/Rules with a **selection checkbox** (queue to build next, capped at 8 features/batch) distinct from a green **done ✓** badge (built status, not a toggle). One Build button builds the selected set (tightest scope). Right panel always shows the selected item's spec + honest built-vs-pending state. Build chat at the bottom for feedback. Done when committed.
- **Test** — one "Verify & Improve" button LLM-verifies each built story against its Design spec (PASS/FAIL per item, grounded, never fabricated) and drafts concrete improvements for shortfalls; keeps the LIVE-POD view (real preview iframe + provision control). Improvements land as pending Build to-dos: a missed spec item → a **rebuild** (standard model); feedback that changes the requirement → routed to **Design** first. Done when previewed.
- **Publish** — request go-live (Builder deploy review), the live app + governed MCP tools + promotion ladder + lifecycle. Done when live.

**Model tier per stage:** Define — no LLM · **Design — reasoning** (all planning + spec) · **Build — standard only** (codegen from finalized spec, deterministic sequencing, no reasoning escalation) · **Test — reasoning** (verify vs spec) · Publish — no LLM. Each stage shows an honest tier badge.

**Tools (MCP `software`):**
- `create_software(name, description?, template?, domain?)` — new governed app. Seeds a REAL build→push CI workflow + `REGISTRY_PASS` secret into the app's Forgejo repo, so the app image AUTO-BUILDS on every commit to main (Forgejo Actions → registry) with no manual build step.
- `commit(appId, files[], message?)` — write files (re-parsed each commit). A commit pushes main and triggers the auto-build; watch it via `get_software_status`.
- `start_preview(appId)` — private sandbox, no review.
- `request_deploy(appId)` — opens a Builder review card; `decide_deploy(cardId, decision)` — Builder/Admin only.
- `use_connection|use_data|use_knowledge(appId, ref, scope?)` — consume a granted resource by reference (never raw creds).
- `use_as_data(appId)` — snapshot app data → Bronze dataset.
- `promote|archive|delete(appId)` — lifecycle (role-gated).

**Golden path:** `create_software` → `commit` → `start_preview` → `request_deploy` → `decide_deploy` (Builder).

**Constraints:** MCP is a front door, not a back door — same roles, OPA, review gate and audit as the UI. `promote`/`decide_deploy`/`delete` need Builder+. Resources are consumed by reference; no secret reaches the app. `delete` is blocked if another artifact depends on it.
