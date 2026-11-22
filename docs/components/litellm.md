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

## Not reachable from the internet

The gateway has **no public route**, on any profile (the same rule covers Langfuse — see
`docs/components/langfuse.md`). It holds the provider credentials and an admin API, and nothing
outside the cluster needs to call it: os-ui, the worker, the reconcile Job and the query tool
all use the in-cluster Service `agentic-os-litellm:4000`.

* `ingress.hosts.litellm` alone renders nothing — also for a release whose values still carry
  the hostname, which is what `scripts/deploy.sh` deploys (it derives the values from the live
  release). The chart renders the route only with `ingress.restricted.litellm.expose: true`
  **and** a protection annotation under `ingress.restricted.litellm.annotations`; without one
  the render fails.
* `scripts/check-consoles-not-public.mjs` (run by `os-ui/scripts/gate.sh`, so by CI) renders the
  default and the STACKIT profile and fails if either contains an Ingress whose backend is the
  gateway or the Langfuse Service — including the subcharts' own ingress switches.
* Admins open the console through the OS (**Admin → LLM Gateway**, `/tools/litellm/ui`): that
  path is behind the OS login and role gate, and the proxy talks to the in-cluster Service.
* Operators who need the raw API or the Swagger page use a port-forward (below).

**After upgrading a cluster that had the route** (STACKIT before this change): Helm deletes the
`agentic-os-litellm-ingress` object — including any annotation added to it by hand; the
cert-manager `Certificate` it owned goes with it. Two leftovers are harmless and can be removed
by hand: the TLS Secret `litellm.<zone>-tls`, and the DNS record `litellm.<zone>` (Terraform
`ingress_subdomains` no longer lists it; remove it with a targeted apply of
`stackit_dns_record_set.subdomains["litellm"]`, or leave it — the name then answers with the
ingress controller's 404). Check:

```bash
kubectl -n agentic-os get ingress            # no agentic-os-litellm-ingress, no agentic-os-langfuse-web-ingress
curl -sS -o /dev/null -w '%{http_code}\n' https://litellm.<zone>/health/liveliness   # 404
```

**If you must publish it** — in a private overlay, never in a committed profile:

```yaml
ingress:
  hosts:
    litellm: "litellm.<zone>"
  restricted:
    litellm:
      expose: true
      annotations:
        nginx.ingress.kubernetes.io/whitelist-source-range: "203.0.113.7/32"   # your egress IP(s)
```

Accepted protections: `whitelist-source-range` (not `0.0.0.0/0`), `auth-url`, `auth-type` +
`auth-secret`, or `auth-tls-verify-client: "on"`.

## Direct access (port-forward)
```bash
kubectl -n agentic-os port-forward svc/agentic-os-litellm 4000:4000
# Admin UI: http://localhost:4000/tools/litellm/ui   (SERVER_ROOT_PATH=/tools/litellm)
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
    -d '{"model":"sovereign-worker","messages":[{"role":"user","content":"hi"}]}'
  ```
  The OS calls three names only: `sovereign-strong`, `sovereign-worker`, `sovereign-embedding`. Each means a model
  in the catalog (the chart seeds `stackit-gpt-oss-20b`, `stackit-qwen3-vl-235b` and an embedding model); an admin
  re-points a role in Platform → Models ("The three role names" below).
- **Virtual keys + cost caps:** UI → *Virtual Keys*. The agents use a scoped key
  (`sk-agents-local-dev`, alias `sovereign-agents`) limited to the `litellmAgentKey.models`
  allowlist with a budget — see "The shared agent key: created by the chart, owned in LiteLLM" below.
- **MCP tools:** registered tool servers appear at `/v1/mcp/tools`; agents call them through
  LiteLLM's `/mcp` endpoint (see the governed Trino query-tool doc).

## Engineering view ("Under the hood") — not yet

The panel has **no LiteLLM tab yet** (checklist T10, backlog): the routes per role, the key
**alias** (never the key), the `domain:` / `agent:` / `tab:` / `run:` tags and the budget are
specified and not built. What already holds, and what the tab will have to keep holding: the panel
never shows a key — only an alias — and nothing on that surface may widen what a reader can see.

Operations: adding `LITELLM_SALT_KEY` and rotating the master key —
[`docs/ops/litellm-salt-key.md`](../ops/litellm-salt-key.md).

## FAQ
**Q: "Not connected to DB" at login?** The UI needs Postgres — it's DB-backed here (CNPG
`litellm`). If you see this, the litellm pod isn't connected; check it's running.
**Q: How do I add a real model?** Add it to `litellm.proxy_config.model_list` with the
provider + an API key secret, then `helm upgrade`. Inference runs on the STACKIT managed
three-tier set (reasoning=Qwen3-VL-235B · standard/worker=gpt-oss-20b · embeddings=
Qwen3-VL-Embedding-8B); the offline mock-model serves embeddings only on kind/local.
**Q: When does STACKIT get called?** Only as the **last-resort** fallback when every self-hosted
route fails/overloads, or for **vision** inputs (`sovereign-vision`). Cost is hard-capped on the
agent virtual key (`litellmAgentKey.maxBudget` per `budgetDuration`; the per-model
`modelMaxBudget` is a LiteLLM Enterprise feature and is not used) and surfaced in Monitoring.
**Q: Why a scoped key for agents?** Least privilege (security.md): agents can only reach the
granted models, capped, and every call is attributable.
**Q: Spend shows 0.** The alias has no price. See "Prices and budgets" below — an unpriced
alias is booked at cost 0 and no budget can trigger on it.
**Q: A request over the rate limit — is it queued?** No. LiteLLM refuses it at once with HTTP
429 (`Rate limit exceeded ... Limit resets at: ...`, header `retry-after`). The router's
`num_retries` retries upstream errors only. The OS backs off and retries
(`tabs/agents/lib/engine/rate-limit.ts`); any other caller has to do the same.

## Prices and budgets

**Every alias carries `model_info`, and the prices in it are what makes a budget real.** The
model ids behind the aliases are custom ids on an OpenAI-compatible endpoint
(`openai/gpt-oss-20b`, `openai/Qwen/Qwen3-VL-235B-A22B-Instruct-FP8`); LiteLLM's built-in price
map has no entry for them. Without `input_cost_per_token` / `output_cost_per_token` LiteLLM
books each call at cost 0: `x-litellm-response-cost` is 0 (or absent), the key's `spend` never
moves, and `max_budget` on the shared key or on a system's own key never triggers. That was the
state of this stack until 2026-11-19 (measured on 1.90.0: three calls of 1,000 + 500 tokens,
key spend `0.0`). With the prices set, the same calls book 0.000275 (standard) and 0.002375
(reasoning).

| Catalog model (STACKIT profile) | Upstream model | Input / output per 1M | per token (`model_info`) | Context / max output | Images | Tools |
|---|---|---|---|---|---|---|
| `stackit-gpt-oss-20b` | gpt-oss-20b | 0.15 / 0.25 EUR | 1.5e-07 / 2.5e-07 | 131K / 8192 | no | yes |
| `stackit-qwen3-vl-235b` | Qwen3-VL-235B-A22B-Instruct-FP8 | 1.50 / 1.75 EUR | 1.5e-06 / 1.75e-06 | 200K / 16384 | yes | yes |
| `stackit-qwen3-vl-embedding-8b` | Qwen3-VL-Embedding-8B | 0.08 EUR input | 8e-08 / 0 | 32000 input | no (the OS sends none) | n/a |

Sources: prices — STACKIT AI Model Serving price table (stackit.com, EUR per 1M tokens, read
2026-11-19); limits, modalities and tool calling — docs.stackit.cloud "Available shared models".
On the base (laptop) profile the embedding model is the bundled mock `mock-embedding` and is priced at 0 on purpose.

* **Currency.** LiteLLM calls its ledger "USD" and converts nothing. The prices are EUR, so
  `maxBudget`, `spend` and every amount in the LiteLLM console are EUR on this stack.
* **One price, two ledgers.** `osUI.modelPricesJson` (Monitoring, per 1M tokens) and
  `model_info` (the gateway, per token) must say the same thing.
  `scripts/check-litellm-model-info.mjs` (in `gate.sh`) fails when they differ, when an alias
  has no price, or when two aliases of the same upstream model are priced differently.
* **`supports_vision`** is true exactly for the aliases on the OS image allowlist
  (`os-ui/core/models/capabilities.ts`); the same check enforces it. It is metadata for
  `/model/info` today — the allowlist is what decides whether the OS sends an image.
* **`max_input_tokens` is informational.** `router_settings.enable_pre_call_checks` is **not**
  enabled: LiteLLM would then reject or re-route a request by its own token estimate, which for
  these open-weight models is a tiktoken approximation, against limits STACKIT publishes rounded
  ("131K", "200K"). The OS already bounds its prompts (`core/models/context-windows.ts`).
  `stream_timeout` is not set either: nothing in the OS streams, so it would bound nothing.
* **Rendering trap.** Helm prints `0.00000008` as `8e-08`, which LiteLLM's YAML parser reads as
  a *string*. 1.90.0 still computes with it (measured: 8 tokens → 6.4e-07); keep prices in the
  values as plain decimals and re-check `GET /model/info` after a gateway upgrade.

### A cluster that carries its own `model_list` (production does)

`model_list` is a list and Helm replaces a list whole. `scripts/deploy.sh` derives its values
from the **live release**, so a release that already holds its own `model_list` never receives
the chart's `model_info`. Apply the priced list once:

```bash
# compare first — the overlay is a copy of the live routing, and the live one wins
helm get values agentic-os -n agentic-os -o yaml | yq '.litellm.proxy_config.model_list'
VALUES_OVERLAY=deploy/overlays/gateway-model-info.stackit.yaml ./scripts/deploy.sh --from-registry <version>
# afterwards
curl -s -H "Authorization: Bearer $MASTER" http://localhost:4000/model/info | jq '.data[] | {model_name, in: .model_info.input_cost_per_token}'
```

`VALUES_OVERLAY` is the supported way to change any release value; what it sets stays in the
release, so it is passed once. **From that deploy on spend counts** — the shared key against
`litellmAgentKey.maxBudget`, each system key against `osUI.agentSystemKey.maxBudget` — so look at
the spend column in the console during the first week and size the caps from what you see.

### The shared key's budget

`litellmAgentKey.maxBudget` per `litellmAgentKey.budgetDuration` (base default 25 per `7d`; the
STACKIT profile 250 per `7d`). The key-init Job applies both to the **existing** key on every
upgrade (`/key/update`), not only at creation. What an update does, measured on 1.90.0:

* giving a key a window sets `budget_reset_at` to the next boundary (for `7d`: Monday 00:00 UTC);
* the spend already counted **stays** until that reset — an update never zeroes it. A key whose
  spend is already above a newly lowered `maxBudget` is refused until the reset;
* an empty `budgetDuration` is sent as `null` and **removes** the window (a lifetime cap). The
  Job used to omit the field, which left whatever window the key had.

An exhausted budget is not a rate limit, although both arrive as HTTP 429. Measured on 1.90.0:
a spent key gets `{"error":{"message":"Budget has been exceeded! Current cost: 0.002375, Max
budget: 0.001","type":"budget_exceeded","code":"429"}}`; a rate limit gets `"Rate limit
exceeded for api_key: … Limit type: tokens. Current limit: 1000, Remaining: 0. Limit resets at:
2026-11-19 18:55:46 UTC"` with `type: throttling_error` and the headers `retry-after: 60`,
`rate_limit_type`, `reset_at`. The OS tells them apart by the wording
(`tabs/agents/lib/engine/rate-limit.ts`): it waits and retries a rate limit, and reports a spent
budget as "budget used up" without retrying.

## Models: LiteLLM is the only list

LiteLLM owns providers, credentials, models and global budgets. The model picker (agents, Settings)
and Platform → Models & Providers read **LiteLLM live** — `GET /model/info` for the models and
`GET /credentials` for the connections (names and non-secret info only) — on every request, through
`GET /api/agents/models` (`os-ui/core/models/gateway-catalog.ts`). The OS keeps **no** model list, no
seed catalog, no enable/disable switch and no per-model cap: model access and budgets are LiteLLM's.
A model added in LiteLLM (its UI, its API, or the OS "Add a provider" flow below) appears in the OS
with no change in the OS; one removed there disappears. When LiteLLM cannot be read the OS says so and
lists no models (`source: "unavailable"`); it does not show an old list.

What the OS still decides itself: the per-role defaults (Settings → `modelRoles`) and the assistant
pin. The pin is checked against LiteLLM when it is set (the alias must exist and be a chat model); a
pin at a model that LiteLLM later loses is not hidden, the gateway's own "model not found" answers the
call and "Remove" clears a pin at the removed model.

**Config file or database — which is authoritative.** `store_model_in_db` is on, so two kinds coexist,
and the page says which each model is (**Managed by**):

| | Where it is defined | Authoritative | Editable / removable in LiteLLM |
|---|---|---|---|
| `config` (deployment config) | `litellm.proxy_config.model_list` in the chart values | the chart values — change them with a deploy; they are rewritten from the file at every start | no (`db_model: false`) |
| `database` (LiteLLM database) | LiteLLM's own database: its UI, `/model/new`, the OS "Add a provider" flow | LiteLLM | yes (`db_model: true`) |
| `mixed` | one alias served by both | treated as config (the file's part cannot be removed) | partly |

The OS removes only `database` models (`/model/delete` after checking `db_model` on every deployment
of the alias); a config model is refused, and LiteLLM itself refuses it too. A row with no `db_model`
flag is read as `config`, so ambiguity never offers a Remove button. Older releases also mirrored a
catalog (`enabled`, `capEUR`, endpoints) into the `os-model-config` index; those documents are no
longer read.

### The three role names: the OS owns the mapping, LiteLLM owns the catalog

The OS calls only three model names: `sovereign-strong`, `sovereign-worker`, `sovereign-embedding`. Each
maps to a model in the LiteLLM catalog (the real models, under their real names, added by the platform team in
LiteLLM). The **mapping is the OS's**: edited in Platform → Models (admin only, audited), stored as the file
`os/models.yml` in the platform repository (versioned, diffable, restorable), and **enforced at the gateway**
by writing LiteLLM's documented `router_settings.model_group_alias` with `POST /config/update` — so os-ui, agent
keys and apps all resolve a role the same way, at the gateway; the OS does no client-side resolution.
Platform → Models shows each role's model with its price per 1M tokens (from the catalog entry) and a link to LiteLLM.

* **Remap = no restart.** Measured on 1.109.1: `/config/update` applies at once and survives a gateway restart (it
  is stored in LiteLLM's database). **LiteLLM refuses to change an alias that is set in its config file**
  ("is set in the config file and cannot be changed here"), so the chart must never set `model_group_alias`
  (`scripts/tests/litellm-no-config-alias.test.sh`).
* **Reconcile** at boot and every `MODEL_ROLE_RECONCILE_INTERVAL_SECONDS` (default 300; 0 = off). An alias that is
  absent is created; one someone changed in LiteLLM is put back **and reported** (audited `gateway.models.reconcile`,
  shown in Platform → Models). Aliases the OS does not own are left alone. No `os/models.yml` yet = nothing is
  written (the OS invents no model names).
* **Validation, no silent fallback.** A mapping to a model that is not in the catalog is refused (422,
  `unknown_catalog_model`). A catalog model removed while a role points at it is a red warning; the alias is NOT
  changed, so a call fails with LiteLLM's own typed error ("no healthy deployments") instead of answering from
  another model.
* **Old names** keep working for one release as aliases of the roles: `sovereign-default`, `sovereign-mock` →
  worker; `sovereign-reasoning`, `-reasoning-fast`, `-premium`, `-vision` → strong; `sovereign-embed` → embedding.
  A deprecated name that is itself a real catalog model (today's config-file `sovereign-default`) is not aliased
  over — the real model wins. Once the roles are mapped, a setting that still names an old alias logs one
  deprecation line.
* **Aliases are not models.** LiteLLM 1.109.1 lists every alias as a `db_model: true` row in `/model/info`; the OS
  reads `GET /router/settings` and takes the aliases out of the catalog.
* **Cost** stays per model: catalog entries carry real per-token prices (`input_cost_per_token` /
  `output_cost_per_token` in `litellm_params` — 1.109.1 drops them from `model_info` on `/model/new`), so spend per key,
  per team and per model keeps working under a role.

### Every OS model call uses the three role names

os-ui's own roles map onto the three names: standard and tools → `sovereign-worker`; reasoning and coder →
`sovereign-strong`; embeddings → `sovereign-embedding` (`core/models/roles.ts`). No model name is in os-ui code:
`core/models/role-call-sites.guard.test.ts` fails on a hard-coded model name outside the deprecated-alias table.

* **Gone:** the admin `settings.modelRoles` override (the Settings and Models & Providers role dropdowns) and the
  `LITELLM_*_MODEL` / `KNOWLEDGE_EMBED_MODEL` / `FILES_EMBED_MODEL` env defaults. `PATCH /settings` with `modelRoles`
  answers 410. What a role means is only `os/models.yml` (Platform → Models).
* **First mapping.** At boot, when `os/models.yml` does not exist, the OS writes it once (`core/models/role-seed.ts`):
  per role the old override if it names a catalog model, else the chart seed `osUI.modelRoles.seed`, else — a
  cluster that carries its own catalog under the old names, as production does — the old name of that role when
  the catalog still serves it. A role with none is `incomplete` and nothing is written. An existing file is never
  touched, so the run is idempotent. Preview: `POST /api/platform-admin/models/roles/migrate {"dryRun": true}` (admin).
* **Keys.** An agent system's key (`keyWanted`) and the shared key (`litellmAgentKey.models`) always allow the three
  role names, so a remap needs no key rebuild (measured: the same key, the next call, the new model). A key that does
  not list the roles is refused, so an EXISTING key must be updated once (the key reconcile reports it as drift; the
  shared key needs `litellmAgentKey.reapplyOnUpgrade: true` once or an edit in LiteLLM).
* **Catalog seed (chart).** `litellm.proxy_config.model_list` seeds real names: `stackit-gpt-oss-20b`,
  `stackit-qwen3-vl-235b`, and the embedding model (`stackit-qwen3-vl-embedding-8b` on STACKIT, `mock-embedding` on
  the local profile). The old aliases are no longer config models; the OS writes them as aliases of the roles for one
  release (a cluster whose own list still has them keeps them as real models). Models added in LiteLLM live in its
  database and are never touched by a deploy or by this chart.
* **Budgets and cost** are LiteLLM's: spend is booked per key, per role (`model_group` in the spend log) and per
  catalog model (`model_id`), at the price on the catalog entry (`scripts/check-litellm-model-info.mjs`).
* **Images** are allowed to the `sovereign-strong` role (and its old names). Map `strong` to a model that accepts
  images, or set `osUI.imageAllowlist`.

### Fallbacks per role (measured on LiteLLM 1.109.1, `scripts/tests/gateway-models`-style container)

* **Through the API.** `POST /config/update {"router_settings":{"fallbacks":[{"sovereign-strong":["…"]}]}}` works when
  the config FILE sets no `fallbacks`: it applies at once and survives a restart. The key is the ROLE name — a
  fallback keyed by the catalog model never fires for a call made through a role. The list is replaced whole.
  When the file sets `fallbacks` LiteLLM refuses ("is set in the config file and cannot be changed here"), so the
  STACKIT profile no longer sets any.
* **The target must be allowed on the caller's key**, else the fallback is skipped ("the caller is not authorized to
  call it"). A fallback to another role (`sovereign-strong` → `sovereign-worker`) works with the keys as they are; a
  fallback to a specific catalog model (e.g. STACKIT Qwen when Lyceum fails) needs that model on every key
  (`AGENT_SYSTEM_KEY_FALLBACKS_JSON` carries it onto system keys; the shared key's list or the
  `os-admin-registered` access group the shared key holds).
* **`/fallback`** takes a real model group; it rejects a role alias ("not found in router"), so it cannot give a role a
  fallback.
* **Deployment order inside one model group** (two deployments under the same `model_name`, `order: 1/2`) fails over
  to the second when the first fails, with no fallback setting — but both deployments are then the same catalog
  entry, so a call to that name can be answered by either model.
* The OS does not manage fallbacks yet; this is the documented route for it.

Proof against the real gateway: `scripts/tests/gateway-models/run.sh` (the `gateway-models-live` workflow).

## Adding a provider (Azure, OpenAI-compatible, Ollama, Mistral, STACKIT, any LiteLLM provider)

Platform → Models & Providers → **Add a provider**. Every step is LiteLLM's own admin API; the OS code
is `os-ui/tabs/admin/lib/llm-providers.ts` (presets: `llm-provider-presets.ts`).

| Step | LiteLLM API | Notes |
|---|---|---|
| Provider | `GET /public/providers/fields` | Presets are only a LiteLLM provider id + default endpoint. STACKIT = `openai` + its URL. |
| Connection | `POST /credentials` | Endpoint, key, `api_version` (Azure). Encrypted in LiteLLM's DB with `LITELLM_SALT_KEY`; `GET /credentials` masks the key. The OS stores no key. |
| Model | `GET /public/litellm_model_cost_map` | Suggestions for Mistral / other global providers; Azure deployments, Ollama tags, vLLM ids are free text. |
| Test | `POST /health/test_connection` | `{litellm_params:{model, litellm_credential_name}, mode}`; errors become one sentence. |
| Register | `POST /model/new` | `model: <provider>/<model>` (native prefix — no forced `openai/`), `litellm_credential_name`, `model_info.access_groups: [llmProviders.accessGroup]`. This is the whole registration: the OS writes no model row of its own; the list reads LiteLLM. |

- **Agents can use it at once**: the shared agent key holds the access group (`litellmAgentKey.models`
  gets `llmProviders.accessGroup` appended by the key-init Job).
- **Egress**: the gateway's outbound calls go through the egress proxy (`litellm-egress-env`:
  HTTP(S)_PROXY / NO_PROXY). A provider host must be on `llmProviders.allowHosts` (the STACKIT host is
  added automatically when `stackitPremium.enabled`). The flow refuses a host that is not, before
  storing anything, and prints the values change.
- **SSRF guard**: an endpoint that names or RESOLVES (os-ui checks the DNS answer, every address) to a
  cluster-internal or private address — a Service name, `*.svc`, RFC1918, CGNAT, ULA, link-local,
  metadata — is refused unless the deployment names it in `llmProviders.localModels` (how an in-cluster
  Ollama or vLLM is connected on purpose; listed names join NO_PROXY). Metadata, loopback and
  link-local answers are refused always. OS services (`mock-model`, `opensearch`, …) are never providers.
- **The gateway cannot go direct**: with the proxy on, the gateway leaves the any-443 NetworkPolicy and
  gets `litellm-egress` (the egress proxy on 3128, its database on 5432, `llmProviders.localModelNamespaces`;
  DNS and same-namespace services as before). A client inside LiteLLM that ignores HTTPS_PROXY has no path out.
- **Turning it on in an existing cluster**: deploy with `llmProviders.viaEgressProxy=false`, run the dry
  run below, put every `blockedHosts` entry on `llmProviders.allowHosts`, then deploy again with the default
  (`true`).
- **Dry run (before flipping the proxy on)**: `GET /api/platform-admin/providers/migration` lists
  every model, its host, whether the proxy lets it out (`blockedHosts`) and the `/model/update` that
  would put a DB model into the access group. It writes nothing.
- Proof: `scripts/tests/llm-providers/run.sh` (real LiteLLM + the chart's tinyproxy + three provider
  stubs plus two HTTPS providers through CONNECT, a gateway restart, and the wrong-key / blocked-host /
  no-group / untrusted-certificate / private-DNS-answer twins); chart:
  `scripts/tests/llm-providers-chart.test.sh`.

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
`core/infra/litellm-credential.ts` `callerCredential`. Which key a call carries depends on
what the call is, and there is no fallback from one to the other:

- **A run of an agent system** uses that system's **own virtual key** (alias `os-<systemId>`)
  — or it does not run. See "The key of an agent system" below.
- **Everything else** (the assistant, classify, the embedders) uses the **shared agent key**
  the chart provisions (`LITELLM_AGENT_KEY`, alias `sovereign-agents`, idempotent Job
  `litellm-agent-key-init`, re-asserted on every `helm upgrade` — see below).
- With no usable key the caller **refuses**. Nothing ever falls back to the master key, and a
  system run never falls back to the shared key: either fallback would quietly remove the
  very limits the key exists to enforce.

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
Langfuse tags the run trace with. The gateway records each call in Langfuse through its
OpenTelemetry v2 `langfuse_otel` callback (LiteLLM >= 1.109). Every call carries an
`x-litellm-call-id` header, and a W3C `traceparent` header when the caller's trace ids are W3C
ids, which nests the gateway's generation inside the caller's trace
(`os-ui/core/runtime/gateway-trace.ts`; `docs/components/langfuse.md`; proof:
`scripts/tests/litellm-langfuse/run.sh`).

**Rejections are typed.** A 400 budget message is `BudgetExceededError` (402); any other 4xx
on an inference call is `GatewayRejectedError` with `code` `forbidden` (model outside the
key's allowlist) / `unauthorized` / `budget_exceeded` / `rate_limited` / `bad_request`.

**Embeddings never index substitutes** (checklist A31). Both embedders
(`tabs/knowledge/lib/embed.ts`, `tabs/files/lib/embed.ts`) fall back to the deterministic
hash/mock vector **only** for a timeout, a transport error, a 5xx or a mis-dimensioned
reply — and label it (`source: 'offline-hash'` / `mode: 'mock'`). A 4xx **throws**
`GatewayRejectedError`; nothing is indexed. The run-time handoff curation treats a
rejection like the offline source (it indexes nothing).

**No prompt content in the gateway's records (chart).** `litellm_settings.turn_off_message_logging:
true` and `general_settings.store_prompts_in_spend_logs: false` — the gateway logs model, usage,
cost, tags and trace ids to Langfuse and to its spend logs, never the prompt or the completion.
Details and the measured result: `docs/components/langfuse.md` "What the gateway writes".

**No gateway failure callback (chart).** `litellm_settings.failure_callback` is **not** set:
for a request the proxy itself refuses, LiteLLM logs the whole request body, unredacted — see
`docs/components/langfuse.md` "What the gateway writes". A refused or failed call is recorded
by the OS on its own span instead.

**Cache (chart).** `cache: true` on the bundled
Valkey (`cache_params.host: valkey`, password via `extraEnvVars` from `valkey-credentials`)
runs in `mode: default_off`: nothing is cached unless the request says
`cache: {"use-cache": true}`, which only the deterministic paths do (classify at temperature
0, both embedders). Agent runs never opt in.

## Reconcile: OS → LiteLLM, one way, plan first

`GET /api/platform-admin/gateway/reconcile` returns a plan; `POST` applies it.
The plan has three lists and only two are ever applied:

| List | What it is | Applied? |
|---|---|---|
| `creates` | a team per domain, missing from the gateway | yes |
| `updates` | an OS-owned object missing its ownership stamp | yes |
| `drift` | exists in LiteLLM, not governed by the OS | **never** |

Reconcile does **not** create agent keys (it used to: `agent-<id>`, with no budget and a value
nobody kept). A system's key comes from its Build; the plan lists systems without one under
`needsBuild`.

Two deliberate limits. **Budgets are not pushed**: a cap set in LiteLLM is the
real cap, and reconcile would otherwise undo an admin's work on every run.
**Drift is never deleted**: removing a hand-made key because the OS has no
record of it is the worst thing a reconciler can do.

Writes go through LiteLLM's admin API, so what the OS creates appears in
LiteLLM's own UI with the same aliases, rather than as a divergent shadow
configuration. The POST route ignores its request body and applies a
server-recomputed plan, so an admin session cannot post arbitrary payloads to
the admin API under the master key.

## The key of an agent system

Each agent system has ONE key at the gateway, alias `os-<systemId>`, made by the system's
**Build** (`tabs/agents/lib/build/live.ts`, the `litellm` step) and by nothing else.

| | |
|---|---|
| Value | `sk-` + 32 random bytes (`mintSystemKey`). Never derived from an id. The OS generates it and passes it to `/key/generate` (LiteLLM requires the `sk-` prefix; the gateway setting "disable custom API keys" must be off). |
| Where it is kept | Encrypted (AES-256-GCM, random nonce per record, bound to the system id) in table `agent_system_keys` of the `agent_runs` Postgres database — the store os-ui and `os-ui-worker` already share. Never on the system record, in git, in a trace or in an API answer. |
| Encryption secret | `AGENT_KEY_ENCRYPTION_KEY`, from Secret `os-ui-agent-key-encryption` (chart `osUI.agentKeyEncryption`), on os-ui and the worker. Not the master key. Generated once and kept across `helm upgrade`. |
| Limits | `osUI.agentSystemKey.*`: budget + reset window, requests/min, tokens/min, calls at once. Reconciled on every Rebuild, and watched continuously (below). |
| Models | The system's routed models and pins, the reasoning and tools role models a run uses, and every gateway fallback target of those (`router_settings.*fallbacks`, passed to os-ui as `AGENT_SYSTEM_KEY_FALLBACKS_JSON`). |
| How it is addressed | By its token id (SHA-256 of the value — what LiteLLM calls `token`), found with `/key/list?key_alias=`. |

**A system without a usable key does not run.** A never-built system created after the upgrade,
or a key that cannot be decrypted, stops the run before anything executes, with a message that
says to press Build (`SystemKeyUnavailableError`). It never falls back to the shared key. The
Build & Run panel shows "Build needed" beforehand, and Admin → overview lists every system's key
state.

**Upgrading from guessable keys: a migration, not a sweep.** Before this, a system's key was
`sk-os-<systemId>` (guessable), or the system ran on the shared key. At every os-ui start,
`tabs/agents/lib/build/system-key-migration.ts` moves every existing system that has no usable
stored key onto a random, budgeted key, through the Build's own `litellm` step. Nobody has to
press Rebuild and no schedule stops:

1. stage the new value, sealed, in `agent_system_key_staging` (with the old keys it retires);
2. move each old key to the alias `os-<id>.retiring.<token prefix>` (`/key/update` with
   `key_alias`): its value keeps working, the alias is free;
3. `/key/generate` the staged value under `os-<id>`, with the configured budget and limits;
4. store it in `agent_system_keys`: from here every run uses it;
5. give the old key(s) LiteLLM's own expiry (`/key/update` with `duration`,
   `AGENT_SYSTEM_KEY_RETIRE_GRACE_SECONDS`, default 600 s), then close the staging row. A run
   still holding the old value keeps working until then; afterwards the gateway answers 401
   `expired_key`, and the sweep deletes the expired `.retiring.` key.

A crash at any step is finished by the next pass with the same staged value. Until a pass has
processed every system without a failure (`agent_system_key_migrations`), a worker run whose
system has no stored key waits up to three minutes for it instead of failing. Each move is an
audit entry `gateway.key.migrate` (alias and outcome only). After the migration, the sweep
(`core/infra/agent-system-key-sweep.ts`) removes what nothing can be running on: derivable keys
of systems that no longer exist, and the unbudgeted `agent-<id>` keys of the old reconcile. It
never deletes the guessable key of an existing system; when the registry has not hydrated it
deletes no derivable key at all. Proven against the real gateway image by
`scripts/tests/agent-key-migration/run.sh` (workflow `agent-key-migration-live`).

**Rotation** uses the same make-before-break steps (LiteLLM's own rotation endpoints are
Enterprise): Admin → "Replace key", or
`POST /api/platform-admin/gateway/system-keys {"action":"rotate","systemId":"…"}`. The old key
keeps working through the grace period. A call that still gets a 401 (after the grace, or with a
grace of 0) re-reads the store and is repeated once with the new key — in the v1 caller
(`core/runtime/runtime.ts`) and on the LangGraph module path (`ownKeyRetryFetch` in
`core/adapters/litellm/chat-model.ts`, the OpenAI SDK's `fetch` option). The
key's spend counter starts again from zero (it is a new key); spend by tag is unaffected.

**If the encryption secret is lost or changed**, every stored key is unreadable; the next os-ui
start re-issues them (the migration treats an unreadable key as missing), or a Rebuild does.
Nothing else is lost. The secret is in the External Secrets catalog (`os-ui-agent-key-encryption`)
and both os-ui and the worker refuse a production boot without it (the secret guard and the deploy
preflight).
On Argo CD / Flux / `helm template` pipelines set `osUI.agentKeyEncryption.secret` or
`.existingSecret`, because a generated value cannot be kept there.

### Deployment caveat

The scoped key ships with `litellmAgentKey.maxBudget: 25` per `7d` and the
`litellmAgentKey.models` allowlist (four aliases today). Before enabling this in
production, check that the key's remaining budget and its allowlist cover real
traffic — otherwise runs will correctly but unhelpfully fail closed with
`budget_exceeded` or `key_model_access_denied` (an HTTP 403 saying
"key not allowed to access model").

### The shared agent key: created by the chart, owned in LiteLLM

**Who owns what.** LiteLLM owns providers, credentials, models, global budgets and teams: the
platform team works there directly, and the OS reads it. The OS owns exactly one thing in the
gateway: the virtual key of each agent system (its models, budget, limits and `allowed_tools`,
all derived from the system's grants). The shared key `sovereign-agents` is a platform setting, so
its budget, models and limits belong to the platform team too.

`litellm-agent-key-init` is a normal (non-hook) Job with `ttlSecondsAfterFinished: 300`, so every
`helm upgrade` or ArgoCD sync recreates and re-runs it. It is **create-only**: a missing key is
created with `/key/generate`; an existing key is compared with the chart values (`models`,
`max_budget`, `budget_duration`, `rpm_limit`, `tpm_limit`, `max_parallel_requests`) and every
difference is printed as `[key-drift] <field>: chart=… live=…` — nothing is written, so an edit
made in LiteLLM survives an upgrade (`kubectl -n agentic-os logs job/litellm-agent-key-init`). The
Job never prints a key value. `litellmAgentKey.reapplyOnUpgrade: true` is the explicit opt-in to the
earlier behaviour (`/key/update` with the chart values on every upgrade): use it once to roll a
changed `models` list out, then switch it off. `key_alias` is set at creation only.

History: the first Job exited as soon as `/key/info` found the key, so a chart edit to `models` or
`maxBudget` never reached LiteLLM; production ended up with a key limited to `['sovereign-mock',
'sovereign-embed']` while the chart said four models, and the move off the master key surfaced it
as a 403 on every `sovereign-default` call. The Job then re-applied on every upgrade — which
silently undid hand edits. Now both are explicit: drift is reported, re-applying is a choice.

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

The OS itself requests only the three role names, so the required set is `sovereign-strong`, `sovereign-worker`,
`sovereign-embedding` plus any fallback target (`scripts/check-litellm-role-catalog.mjs` checks the roles on every
profile). Which catalog model a role means is `os/models.yml` (Platform → Models); nothing in the key changes when
a role is remapped.

**Models an admin registers at runtime need no Helm change.** Admin → Models & Providers
(`/api/platform-admin/providers/*`, see "Adding a provider" above) sends `/model/new` with
`model_info.access_groups: ["os-admin-registered"]` (`os-ui/tabs/admin/lib/llm-providers.ts`),
and `litellmAgentKey.models` lists that **access group** — LiteLLM's documented model access
groups — so the shared key can call every registered alias at once. A cluster whose release
values carry their own `litellmAgentKey.models` (production) must add `os-admin-registered` there.
Before this (measured on 1.109.1, 2026-11-20) a registered alias answered `key_model_access_denied`
(403) on every chat and assistant call until an operator listed the alias by hand. The `tools` role
(the agents' execution tier) follows the admin's Standard pin unless an env var or an explicit
`tools` pin says otherwise, and the run worker re-reads the settings doc (at most every 5 s) before
each run, so a role pin reaches agent runs, not only chat.

**Provider traffic through the egress proxy.** LiteLLM honours `HTTPS_PROXY` (verified on 1.109.1:
its CONNECT appears in the tinyproxy log, and a host that is not on `egressProxy.allowlist` is refused
with `Proxying refused on filtered domain`). The chart now does this: `litellm-egress-env` carries
`HTTP(S)_PROXY` and a `NO_PROXY` for the in-cluster hosts, and provider hosts join the filter through
`llmProviders.allowHosts` (the STACKIT host automatically) — see "Adding a provider" above.

**Which aliases may be sent images.** Separate from the key allowlist above: the OS keeps an
explicit list of aliases that may receive images (`os-ui/core/models/capabilities.ts`,
`canReceiveImages`). Built-in: `sovereign-reasoning`, `sovereign-vision`, `sovereign-premium`,
`sovereign-reasoning-fast` — the aliases this chart's STACKIT profile points at Qwen3-VL-235B on
STACKIT (EU). Replace it with `osUI.imageAllowlist` (a list of exact `model_name`s; `[]` = none;
env `MODEL_IMAGE_ALLOWLIST`). The list names aliases, not endpoints, so **re-pointing a listed
alias at another endpoint, or adding a router fallback from a listed alias to an unlisted one,
needs the list updated in the same change**. Platform → Models & Providers shows the list in
force. Nothing sends images to a model yet; this is the list the image features will obey.
### The per-system keys are watched continuously

Because the platform team may edit a system's key in LiteLLM, os-ui does not assume it is as Build
left it. Every `osUI.agentSystemKey.reconcile.intervalSeconds` (default 300; the first pass is one
interval after start-up; 0 = off) `tabs/agents/lib/build/key-reconcile.ts` reads each system's key
(`/key/list?key_alias=…&return_full_object=true`) and compares it with what the system's definition
says, using the same `keyWanted`/`keyDrift` the Build's `litellm` step writes and verifies with:
models, budget and reset window, requests/min, tokens/min, calls at once, and `metadata.allowed_tools`.
A **missing** value is drift (a key whose `allowed_tools` stamp was dropped, a key deleted in LiteLLM,
a second key under the alias, a key that is not the stored one); a gateway that cannot be read is
"could not check", never "in sync". A system nobody has built, and one whose key replacement is still
completing, are not drift.

A difference is **reported, not overwritten**: in Admin → Gateway (per system: what differs, since
when, and **Re-apply from the OS**, admin only, audited as `gateway.key.reapply`, the key value does
not change) and in Monitoring → Agents (the viewer's own systems only). An admin can switch
auto-correct on per system (`osUI.agentSystemKey.reconcile.autoCorrectSystems: [<id>]`, `["*"]` for
all); a correction runs the Build's own `litellm` step and is audited as `gateway.key.reconcile`.
Proof on the real gateway: `scripts/tests/agent-key-migration/run.sh` (the `agent-key-migration-live`
workflow).

