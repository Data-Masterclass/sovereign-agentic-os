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
  (`sk-agents-local-dev`, alias `sovereign-agents`) limited to the `litellmAgentKey.models`
  allowlist with a budget — see "The agent key reconciles on every upgrade" below.
- **MCP tools:** registered tool servers appear at `/v1/mcp/tools`; agents call them through
  LiteLLM's `/mcp` endpoint (see the governed Trino query-tool doc).

## Engineering view ("Under the hood") — not yet

The panel has **no LiteLLM tab yet** (checklist T10, backlog): the routes per role, the key
**alias** (never the key), the `domain:` / `agent:` / `tab:` / `run:` tags and the budget are
specified and not built. What already holds, and what the tab will have to keep holding: the panel
never shows a key — only an alias — and nothing on that surface may widen what a reader can see.

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

**No inference path uses the master key** (A3; checklist A25). Every model call —
agent runs, the assistant, the OS assistant, classify, both embedders — goes through
`core/infra/litellm-credential.ts` `callerCredential`, which chooses, in this order and
with no third branch:

1. the system's **own virtual key** when Build minted one, read from the secrets store by
   **reference** (`LastBuild.litellmKeyRef`, never the value on a record);
2. the **shared agent key** the chart provisions (`LITELLM_AGENT_KEY`, alias
   `sovereign-agents`, idempotent Job `litellm-agent-key-init`, re-asserted on every
   `helm upgrade` — see below);
3. otherwise the caller **refuses to run**. There is no fallback to the master key, because a
   fallback would quietly remove both the model allowlist and the spend cap at exactly the
   moment someone misconfigured the thing meant to enforce them.

The master key is reserved for administering the gateway itself, through exactly two doors:
`core/infra/litellm-admin.ts` (reads) and `core/infra/litellm-write.ts` (writes), plus the
key-provisioning client (`tabs/agents/lib/build/live-clients.ts`) and the config definition.
This is enforced, not documented: the `MODEL-KEY` gate test checks the `Authorization`
header of a real run-path call **and** scans every non-test source file under `os-ui/` —
any other file that mentions `litellmMasterKey` fails the gate.

**Attribution (checklist A27).** Every call carries LiteLLM's `user` field as `os-<id>` plus
tags `domain:<d>`, `agent:<systemId>`, `tab:<tab>` and, for an engine run, `run:<runId>`.
That is what makes spend per domain, per agent and **per run** answerable, and it is the
same vocabulary the gateway mirror reads back (`byDomain`, `byAgent`, `byTab`, `byRun`) and
Langfuse tags the run trace with. Engine runs also pass `existing_trace_id` /
`parent_observation_id`, so LiteLLM's own Langfuse callback nests inside the run trace
(`docs/components/langfuse.md`).

**Rejections are typed.** A 400 budget message is `BudgetExceededError` (402); any other 4xx
on an inference call is `GatewayRejectedError` with `code` `forbidden` (model outside the
key's allowlist) / `unauthorized` / `budget_exceeded` / `rate_limited` / `bad_request`.

**Embeddings never index substitutes** (checklist A31). Both embedders
(`tabs/knowledge/lib/embed.ts`, `tabs/files/lib/embed.ts`) fall back to the deterministic
hash/mock vector **only** for a timeout, a transport error, a 5xx or a mis-dimensioned
reply — and label it (`source: 'offline-hash'` / `mode: 'mock'`). A 4xx **throws**
`GatewayRejectedError`; nothing is indexed. The run-time handoff curation treats a
rejection like the offline source (it indexes nothing).

**Cache and failure callback (chart).** `litellm_settings.failure_callback: ["langfuse"]`
makes a rejected or failed call observable (checklist A30). `cache: true` on the bundled
Valkey (`cache_params.host: valkey`, password via `extraEnvVars` from `valkey-credentials`)
runs in `mode: default_off`: nothing is cached unless the request says
`cache: {"use-cache": true}`, which only the deterministic paths do (classify at temperature
0, both embedders). Agent runs never opt in.

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

The scoped key ships with `litellmAgentKey.maxBudget: 5` USD and the
`litellmAgentKey.models` allowlist (four aliases today). Before enabling this in
production, check that the key's remaining budget and its allowlist cover real
traffic — otherwise runs will correctly but unhelpfully fail closed with
`budget_exceeded` or `key_model_access_denied` (an HTTP 403 saying
"key not allowed to access model").

### The agent key reconciles on every upgrade

`litellm-agent-key-init` is a normal (non-hook) Job with
`ttlSecondsAfterFinished: 300`, so every `helm upgrade` or ArgoCD sync recreates
and re-runs it. The Job is idempotent in both directions: a missing key is
created with `/key/generate`, an existing key is **updated** with `/key/update`
to the current chart values — `models`, `max_budget`, `budget_duration`,
`rpm_limit`, `tpm_limit`, `max_parallel_requests` (and `model_max_budget` when
`litellmAgentKey.enterprise` is true). `key_alias` is set at creation only. The
Job logs the allowlist before and after (`kubectl -n agentic-os logs
job/litellm-agent-key-init`) and never prints a key value.

**Until a cluster has been upgraded with this change, an existing key keeps the
allowlist and budget it was first provisioned with.** The earlier Job exited as
soon as `/key/info` found the key, so a chart edit to `models` or `maxBudget`
never reached LiteLLM. This is how production ended up with a key limited to
`['sovereign-mock', 'sovereign-embed']` (the alpha-release list) while the chart
said four models, and why Phase 3 — which moved the run path off the master key
— surfaced it as a 403 on every `sovereign-default` call. Deploying os-ui alone
does not fix a live key; the Job has to run. One-off remedy, either:

```bash
kubectl -n agentic-os delete job litellm-agent-key-init   # if a finished one is still present
helm upgrade ...                                          # recreates and runs the reconciling Job
```

or edit the key by hand in the LiteLLM console (Admin → LLM Gateway, i.e.
`/tools/litellm/ui` → *Virtual Keys* → `sovereign-agents` → models). The Job
will converge the key to chart values on the next upgrade either way.

**`litellmAgentKey.models` must contain every alias the OS's run paths can
send**, or the scoped key fails closed on exactly the model the OS picked. Since A3 this
is a **chart test**: `scripts/check-litellm-allowlist.mjs` (run by `os-ui/scripts/gate.sh`)
asserts, for the base `values.yaml` and for `values.stackit-managed.yaml` layered over it,
that the allowlist covers every `LITELLM_*_MODEL` / `*_EMBED_MODEL` default in
`core/kernel/config.ts` and every `router_settings.fallbacks` source and target (A5 removed the
`agentRuntime.*Model` inputs with the Python runtime they belonged to — os-ui's own config
defaults and the router's fallback maps are now the complete set of aliases the OS can request). It caught a real gap on first run: the STACKIT overlay's fallbacks target
`sovereign-premium` and `sovereign-reasoning-fast`, which the base four-alias list never
allowed — the overlay now carries its own `litellmAgentKey.models`. The aliases come from:

| Role / use | Source | Default alias |
|---|---|---|
| standard (worker) | `config.litellmExecModel` ← `LITELLM_EXEC_MODEL` | `sovereign-default` |
| chat / offline fallback | `config.litellmChatModel` ← `LITELLM_CHAT_MODEL` | `sovereign-mock` |
| reasoning | `config.litellmReasoningModel` ← `LITELLM_REASONING_MODEL` | `sovereign-reasoning` |
| tools | `config.litellmToolsModel` ← `LITELLM_TOOLS_MODEL` | `sovereign-default` |
| knowledge embeddings | `config.embedModel` ← `KNOWLEDGE_EMBED_MODEL` | `sovereign-embed` |
| files embeddings | `config.filesEmbedModel` ← `FILES_EMBED_MODEL` | `sovereign-embed` |

plus any **admin override** per role in Platform Settings (`modelRoles`, read by
`core/models/roles.ts`). Renaming an alias or re-pointing a role means updating
`litellmAgentKey.models` in the same change; the Job will push the new list on
the next upgrade.
