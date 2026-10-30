# LiteLLM — model & MCP gateway

**What it is:** LiteLLM (MIT) is the **one governed endpoint** agents call for both **models**
and **MCP tools**. It enforces per-key access + cost caps, logs every call (to Langfuse), and
fronts the registered MCP tool servers (the governed Trino `query` tool, etc.). DB-backed (CNPG
`litellm`) so the admin UI, virtual keys and spend tracking work.

## Access — from inside the OS, no second login

> **The link must point at `/tools/litellm/ui`, not `/tools/litellm`.** LiteLLM's
> root serves its FastAPI Swagger page, whose assets are root-absolute and
> therefore 404 behind the proxy prefix — the tab opens blank with the title
> "API - Swagger UI". The admin console lives at `/ui` under `SERVER_ROOT_PATH`.
> `tabs/admin/lib/sections.test.ts` pins this so it cannot regress.

**Admin → LLM Gateway** opens LiteLLM's own admin console *inside* the OS, with the
admin already signed in. The OS proxies it same-origin at `/tools/litellm` and mints the
session server-side (`os-ui/core/infra/tool-sso-litellm.ts`), so no gateway credential
ever reaches the browser.

Two audiences share that one prefix, because `SERVER_ROOT_PATH=/tools/litellm` gives
LiteLLM a single root path:

| Path | Who | Credential |
|---|---|---|
| `public/model_hub` (+ shared assets) | creator and above | none — the key-free model list |
| everything else (models, keys, budgets, guardrails, spend) | **admin only** | UI session minted server-side |

The gate is evaluated **per request**, so a sub-resource call like `/key/list` is refused
for a non-admin with the OS's own 403 rather than falling through to LiteLLM's login form.

The credential is `UI_USERNAME` / `UI_PASSWORD` from the `litellm-credentials` Secret —
the same one LiteLLM itself reads, so there is one credential, not two. It is deliberately
**not** the proxy master key: a leaked UI session must not equal full API access. If it is
unset, the OS reports "not configured" instead of framing a login screen.

## Direct access (port-forward)
```bash
kubectl -n agentic-os port-forward svc/agentic-os-litellm 4000:4000
# Admin UI: http://localhost:4000/ui    API docs: http://localhost:4000/docs
```
**Login:** `admin` / `litellm-admin-local-dev`  ·  **Master key:** `sk-litellm-local-dev-master`

> Both are **local development defaults**. Override `litellmUI.password` and
> `litellmMasterKey` in `values.private.yaml` before any real deployment — the UI
> credential is what the OS uses to sign admins into the embedded console.

## How to use it
- **Call a model (OpenAI-compatible):**
  ```bash
  curl http://localhost:4000/v1/chat/completions \
    -H "Authorization: Bearer sk-litellm-local-dev-master" -H "Content-Type: application/json" \
    -d '{"model":"sovereign-mock","messages":[{"role":"user","content":"hi"}]}'
  ```
  Models (all inference on the STACKIT managed three-tier set): `sovereign-reasoning`
  (reasoning, Qwen3-VL-235B), `sovereign-default` (standard/worker, gpt-oss-20b) with
  `sovereign-mock` as its back-compat alias, `sovereign-embed` (embeddings,
  Qwen3-VL-Embedding-8B, 4096-dim), `sovereign-vision` / `sovereign-premium`
  (Qwen3-VL — vision + last-resort). Admin can re-point each role in Platform Settings.
- **Virtual keys + cost caps:** UI → *Virtual Keys*. The agents use a scoped key
  (`sk-agents-local-dev`, alias `sovereign-agents`) limited to those two models with a budget.
- **MCP tools:** registered tool servers appear at `/v1/mcp/tools`; agents call them through
  LiteLLM's `/mcp` endpoint (see the governed Trino query-tool doc).

## FAQ
**Q: "Not connected to DB" at login?** The UI needs Postgres — it's DB-backed here (CNPG
`litellm`). If you see this, the litellm pod isn't connected; check it's running.
**Q: How do I add a real model?** Add it to `litellm.proxy_config.model_list` with the
provider + an API key secret, then `helm upgrade`. Inference runs on the STACKIT managed
three-tier set (reasoning=Qwen3-VL-235B · standard/worker=gpt-oss-20b · embeddings=
Qwen3-VL-Embedding-8B); the offline mock-model serves embeddings only on kind/local.
**Q: When does STACKIT get called?** Only as the **last-resort** fallback when every self-hosted
route fails/overloads, or for **vision** inputs (`sovereign-vision`). Cost is hard-capped on the
agent virtual key (`litellmAgentKey.modelMaxBudget`) and surfaced in Monitoring (Langfuse cost).
**Q: Why a scoped key for agents?** Least privilege (security.md): agents can only reach the
granted models, capped, and every call is attributable.
**Q: Spend shows 0.** The mock model has no pricing; with a priced model spend tracks + the
cap enforces.

## What the OS reads back (the gateway mirror)

The OS never re-enters what LiteLLM already knows. One admin-only endpoint,
`GET /api/platform-admin/gateway`, returns a single mirror of the gateway —
models and their health, teams with budget and spend, keys and who owns them,
guardrails, spend per dimension, and anything in LiteLLM that has no OS
counterpart. Four admin surfaces render it: the Admin overview, Domains,
Billing and Components.

Three rules make it trustworthy:

* **It degrades, it does not lie.** When the gateway cannot be read the panel
  says so and shows the last good read *with its original timestamp*. An
  unreachable gateway is never drawn as a gateway with nothing in it.
* **Drift is listed, never adopted.** A team or key created directly in
  LiteLLM shows up as `unmanaged`. The OS changes nothing about it; an admin
  decides whether to adopt it in the OS or remove it in LiteLLM.
* **Unattributed spend stays unattributed.** Per-domain, per-agent and per-tab
  spend come from LiteLLM request tags (`domain:`, `agent:`, `tab:`). Untagged
  traffic is not guessed at, so those figures read as "not yet tagged" rather
  than as zero. Amounts are LiteLLM's own USD ledger; Monitoring prices OS run
  traces separately in EUR, and the two answer different questions.

The direction of truth is one-way in this phase: the OS owns identity and
policy, LiteLLM is the enforcement point and the ledger, and the OS only reads
the second half. Reconciliation in the other direction is Phase 3 and will live
in its own module, so "we observe the gateway" and "we change the gateway" stay
separable by a reviewer.

## How the OS calls the gateway (and what it must never use)

Run traffic uses a **scoped virtual key**, never the proxy master key. The chart
provisions it and an idempotent Job registers it in LiteLLM with a model
allowlist and a USD cap; os-ui reads it as `LITELLM_AGENT_KEY`. The master key
is reserved for administering the gateway itself.

This is enforced, not documented: the `MODEL-KEY` gate test inspects the
outgoing `Authorization` header of a real run-path call and fails if it is the
master key.

If no scoped key is configured the run path **refuses to run**. It does not fall
back to the master key, because a fallback would quietly remove both the model
allowlist and the spend cap at exactly the moment someone misconfigured the
thing meant to enforce them.

Every call carries attribution: LiteLLM's `user` field as `os-<id>`, plus
`domain:`, `agent:` and `tab:` tags. That is what makes per-domain and
per-agent spend answerable, and it is the same vocabulary the gateway mirror
reads back.

## Reconcile: OS → LiteLLM, one way, plan first

`GET /api/platform-admin/gateway/reconcile` returns a plan; `POST` applies it.
The plan has three lists and only two are ever applied:

| List | What it is | Applied? |
|---|---|---|
| `creates` | a team per domain, a key per agent, missing from the gateway | yes |
| `updates` | an OS-owned object missing its ownership stamp | yes |
| `drift` | exists in LiteLLM, not governed by the OS | **never** |

Two deliberate limits. **Budgets are not pushed**: a cap set in LiteLLM is the
real cap, and reconcile would otherwise undo an admin's work on every run.
**Drift is never deleted**: removing a hand-made key because the OS has no
record of it is the worst thing a reconciler can do.

Writes go through LiteLLM's admin API, so what the OS creates appears in
LiteLLM's own UI with the same aliases, rather than as a divergent shadow
configuration. The POST route ignores its request body and applies a
server-recomputed plan, so an admin session cannot post arbitrary payloads to
the admin API under the master key.

### Deployment caveat

The scoped key ships with `litellmAgentKey.maxBudget: 5` USD and an allowlist of
three models. Before enabling this in production, check that the key's remaining
budget and its allowlist cover real traffic — otherwise runs will correctly but
unhelpfully fail closed with `budget_exceeded` or an unauthorised-model error.
