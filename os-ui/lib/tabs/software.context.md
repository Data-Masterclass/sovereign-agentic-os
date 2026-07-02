# Software tab — build context

**Purpose:** Create → build → preview → governed-deploy real apps (Next.js + Supabase) that live in sovereign Git (Forgejo) and ship Forgejo Actions → Harbor → Argo CD to a live subdomain.

**Tools (MCP `software`):**
- `create_software(name, description?, template?, domain?)` — new governed app.
- `commit(appId, files[], message?)` — write files (re-parsed each commit).
- `start_preview(appId)` — private sandbox, no review.
- `request_deploy(appId)` — opens a Builder review card; `decide_deploy(cardId, decision)` — Builder/Admin only.
- `use_connection|use_data|use_knowledge(appId, ref, scope?)` — consume a granted resource by reference (never raw creds).
- `use_as_data(appId)` — snapshot app data → Bronze dataset.
- `promote|archive|delete(appId)` — lifecycle (role-gated).

**Golden path:** `create_software` → `commit` → `start_preview` → `request_deploy` → `decide_deploy` (Builder).

**Constraints:** MCP is a front door, not a back door — same roles, OPA, review gate and audit as the UI. `promote`/`decide_deploy`/`delete` need Builder+. Resources are consumed by reference; no secret reaches the app. `delete` is blocked if another artifact depends on it.
