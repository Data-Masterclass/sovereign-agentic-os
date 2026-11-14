# Software tab — build context

**Purpose:** Define → design → build → test → governed-publish real apps. An app's source tree **is committed to the domain's git repository** under `apps/<slug>/` — one repo per domain, authored as the acting user, with a sha, a history and a diff. There is **no CI runner, no image builder and no container registry** in the OS: Tier-1 (`spec`) and Tier-2 (`runtime`) apps are served by the OS itself, same-origin, under the viewer's session; the optional `image` mode serves a container the OPERATOR built and published, and a missing image **fails closed and loudly** rather than serving a placeholder.

**Guided flow — five stages, each ONE function (UI):**
- **Define** — name, purpose, **template pick** (Application = the `sovereign-app` scaffold: OS sign-in + Admin + user directory + multi-tenant, and the DEFAULT; Website; APIs only; Empty), and governed context grants. Template locks at creation. The full Define context (template + name/description + purpose) is threaded into every downstream Design spec-draft and Build code-generation prompt — features are grounded in what the app IS.
- **Design** — the SPECIFICATION, read-first, one epic at a time (prev/next). Per user story, three editable lists: **Features**, **Non-functional requirements**, **Rules**. Assistant on the left, epic detail on the right; stories are expandable spec rows; an Edit toggle flips read↔edit. Done when every story has a spec.
- **Build** — EXECUTION. Left tree = Epics › Stories › Features/NFRs/Rules with a **selection checkbox** (queue to build next, capped at 8 features/batch) distinct from a green **done ✓** badge (built status, not a toggle). One Build button builds the selected set (tightest scope). Right panel always shows the selected item's spec + honest built-vs-pending state. Build chat at the bottom for feedback. Done when committed.
- **Test** — one "Verify & Improve" button LLM-verifies each built story against its Design spec (PASS/FAIL per item, grounded, never fabricated) and drafts concrete improvements for shortfalls; keeps the LIVE-POD view (real preview iframe + provision control). Improvements land as pending Build to-dos: a missed spec item → a **rebuild** (standard model); feedback that changes the requirement → routed to **Design** first. Done when previewed.
- **Publish** — request go-live (Builder deploy review), the live app + governed MCP tools + promotion ladder + lifecycle. Done when live.

**Model tier per stage:** Define — no LLM · **Design — reasoning** (all planning + spec) · **Build — standard only** (codegen from finalized spec, deterministic sequencing, no reasoning escalation) · **Test — reasoning** (verify vs spec) · Publish — no LLM. Each stage shows an honest tier badge.

**Tools (MCP `software`):**
- `create_software(name, description?, template?, domain?)` — new governed app. Seeds the app's starting source tree; the OS previews and serves it directly.
- `push_app_files(appId, files[], message?)` — **the one documented verb for "code in Claude, push to the OS".** Writes the files into `apps/<slug>/` of the domain repository through the governed commit path, as YOU. Returns `{ commit, changed, gate, previewUrl }`. The compile gate runs **before** the write: a red gate is a 422 carrying the diagnostics and nothing is committed. Pushing the same files twice yields **one** commit (`changed: false`).
- `read_app_files(appId, path?)` — the read-back, from git (labelled `governed-commit`), the read cache (`mirror-cache`), or the template seed (`template-seed`) — the answer always says which.
- `commit(appId, files[], message?)` — the older developer-mode write (builder/admin only). `push_app_files` is the documented path.
- `start_preview(appId)` — private sandbox, no review.
- `request_deploy(appId)` — opens a Builder review card; `decide_deploy(cardId, decision)` — Builder/Admin only.
- `use_connection|use_data|use_knowledge(appId, ref, scope?)` — consume a granted resource by reference (never raw creds).
- `use_as_data(appId)` — snapshot app data → Bronze dataset.
- `promote|archive|delete(appId)` — lifecycle (role-gated).

**Golden path:** `create_software` → `push_app_files` → `start_preview` → `request_deploy` → `decide_deploy` (Builder).

**Calling agents, and being called:** a governed app's SDK exposes `os.agents.run(systemId, message)`, `os.agents.get(systemId, runId)` and `os.agents.decide(approvalId, decision)`. All three post to the **same routes the OS UI posts to**, same-origin with the ambient session — so the app acts **as the signed-in user**, never under a service principal and never with a key of its own, and it can reach nothing its viewer could not reach in the UI. A run held on a write comes back as `state: 'parked'` **with its approval id**. Every such call carries a per-render, OS-minted intent scoped to `agent-run` and nothing else: an app **cannot** decide an approval — `os.agents.decide` asks the OS to show the user a confirmation, and the user decides in Governance. The other direction: an app **declares** its agent-callable actions in `actions.yml` (name, description, `write`, `scopes`, `input`), and an agent may call one only through the four-layer fail-closed intersection **capability ∩ declaration ∩ adoption ∩ grant** — a domain administrator of the calling domain must adopt the actions first, and a writing action is **held** for human approval under the reads-on/writes-off preset.

**Constraints:** MCP is a front door, not a back door — same roles, OPA, review gate and audit as the UI. `promote`/`decide_deploy`/`delete` need Builder+. Resources are consumed by reference; no secret reaches the app. `delete` is blocked if another artifact depends on it.
