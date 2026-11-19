# Feature map: LiteLLM

LiteLLM is the gateway. Every model call from the OS goes through it. It holds the keys, the rate
limits, the budgets and the spend record. This page lists each LiteLLM feature and says how the OS
uses it today and what we propose.

- "In the OS today" was verified by reading the code and chart at commit `b47e2cd5` (2026-11-19). Lines marked "live" were seen on the production system on 2026-11-19.
- "Target", "Simple mode default" and "Developer mode override" are **proposed**. See [`design.md`](design.md).
- "Phase" refers to [`plan.md`](plan.md). A dash means no change is planned.
- Paths are relative to `os-ui/` unless they start with `charts/`, `docs/` or `values`. `values.yaml` means `charts/sovereign-agentic-os/values.yaml`. `live.ts` and `live-clients.ts` are in `tabs/agents/lib/build/`.

Status words:

| Word | Meaning |
|---|---|
| **Used** | The gateway feature itself is used. |
| **Hand-built** | The OS has its own code that does this job instead. |
| **Not used** | Neither exists. |
| **Misused** | The feature is used in a way that does not do what is intended. |
| **Blocked** | LiteLLM Enterprise only. Not usable under the licence rule (only Apache-2.0, MIT, BSD and ISC components). |

Who sets what, by owner decision: model keys are managed centrally by admins. Users have no keys.
The master key is never in the browser and never on the run path. Where a "Developer mode
override" is listed below, it means a builder may change that setting for their own system, up to
a limit an admin sets.

## Installed versus latest

| Item | Deployed | Latest stable (2026-11-19) | Gap |
|---|---|---|---|
| LiteLLM proxy | 1.90.0 (live; chart pin `charts/sovereign-agentic-os/Chart.yaml:52-55`) | 1.110.1. Long-term-support line: 1.108.12. | About 20 minor versions. |
| Published security advisories covering 1.90.0 | GHSA-3cv6-jpf6-8222 (medium, fixed in 1.90.7), GHSA-g5ff-637f-6q2m (high, fixed in 1.95.0), GHSA-2rwg-2wh4-7c4f (high, fixed in 1.106.9), GHSA-w4c7-34wj-hqm8 (critical, titled "on Enterprise proxy", fixed in 1.103.10) | — | All four are fixed in 1.108.12 and later. Whether the fourth affects a proxy without an Enterprise licence was not confirmed. |

## The five biggest gaps

1. **The gateway is reachable from the internet** at its own hostname, with only its own key check in front (live: it answers 401 without a key). It is also about 20 versions old with four published advisories. The owner's decision on removing the public hostname is pending.
2. **A system's own key can be guessed and is usually not the key that is used.** Its value is `sk-os-<systemId>`. It is kept only in the memory of one process, so the worker falls back to the shared key (defects F3, F4). Read in code; not observed on the running system.
3. **Budgets never reset.** 5 USD for the lifetime of a key, on the shared key and on every system key. When it is used up, everything on that key stops until an admin acts (defect F5). Read in code. On main since PR #92, system keys default to 5 USD per 7 days.
4. **A rate-limit reply is treated as a fatal error.** The gateway answers "429, try again later"; the OS does not wait and does not try again (defect F2; fixed on main by PR #91). The chart comment that says the gateway queues such requests is wrong.
5. **The gateway writes full prompts and replies into Langfuse**, next to the OS's own redacted record of the same call. Redaction is bypassed and usage is recorded twice (defect F16).

---

## Keys, budgets and limits

| Feature | What it is for | In the OS today | Where | Target | Simple mode default | Developer mode override | Phase |
|---|---|---|---|---|---|---|---|
| Virtual keys (`/key/generate`, `/key/info`) | Give each workload its own key with its own models, budget and limits. | **Misused.** Build creates a key per system, but its value is the guessable `sk-os-<systemId>`, it is kept only in one process's memory, and runs in the worker use the shared key instead. | `live-clients.ts:95-106`, `:127-139`; `core/infra/secrets.ts:21-40`; `core/infra/litellm-credential.ts:108-111` | One key per system with a random value, stored durably and encrypted, used by web and worker alike. No silent fallback. | Automatic. | None. | 0 |
| A second key per agent from the admin reconcile | Same purpose, created from Admin → LLM Gateway. | **Misused.** The admin reconcile creates keys named `agent-<id>` with no budget. The run path never reads them. Two key schemes exist side by side. Read in code, not traced further. | `tabs/admin/lib/litellm-reconcile.ts:71`, `:96-104` | One scheme. Remove or merge the second. | — | — | 0 |
| `/key/update`, `/key/delete`, `/key/block` | Change, remove or block a key. | **Not used** by Build. Rebuild never updates an existing key. The admin reconcile uses `/key/update` only to stamp ownership. | `live.ts:197-198`; `tabs/admin/lib/litellm-reconcile.ts:113` | Rebuild updates models, budget and limits. Deleting a system deletes its key. | Automatic. | None. | 0 (on main: PR #92, merged; Rebuild now calls `/key/update`) |
| Key rotation (`/key/{key}/regenerate`, auto-rotate) | Replace a key's value on a schedule. | **Blocked.** Enterprise. | — | Do it by hand in the OS: create a new key, switch the stored secret, delete the old key. | Automatic on Rebuild after a leak. | None. | 0 |
| Tags stored on a key | Label keys. | **Blocked.** Enterprise. | — | Not needed. The key alias and metadata carry the system id. | — | — | — |
| Tags on a request (`metadata.tags`) | Label each call so spend can be split by domain, system and run. | **Used.** `domain:`, `agent:`, `tab:`, `run:`, `env:`. | `core/infra/litellm-credential.ts:102-107` | Keep. This is how the benchmark is measured. Re-test after each gateway upgrade. | On. | Extra tags. | — |
| Teams, users, end users | Group keys and budgets. | **Used**, lightly. The admin reconcile creates one team per domain, without a budget. `user` is sent on every call for attribution only. | `tabs/admin/lib/litellm-reconcile.ts:83-91`; `core/infra/litellm-credential.ts:91-93` | A budget on the domain team as the ceiling above system budgets. Organisations and project admins are Enterprise and stay unused. | Automatic. | None (admin). | 4 |
| `max_budget` with `budget_duration` | A spend cap that resets every period. | **Misused.** A cap is set, the reset period is not. 5 USD is a lifetime cap on the shared key and on each system key. | `values.yaml:390-393`; `live.ts:82-87` | Every budget resets. | 10 USD per 30 days per system (owner decision 5). | Amount and period, within the admin cap. | 0 (on main for system keys: PR #92, merged, default 5 USD per 7 days) |
| Several budget windows on one key (`budget_limits`) | For example a daily and a monthly cap together. | **Not used.** The version that introduced it was not confirmed; assume it is not in 1.90.0. | — | Daily guard next to the monthly budget, once the upgraded gateway has it. Until then the OS checks the day's spend itself. | 2 USD per day. | Within the admin cap. | 4 |
| Per-model budget (`model_max_budget`) | A separate cap for an expensive model. | **Blocked.** Enterprise. Build still writes a value into the key's free-text metadata, where nothing reads it. | `live-clients.ts:123-126`, `:137`; `live.ts:201-205` | Stop writing it. Use the allowed-models list instead: Simple systems do not get the most expensive model. | — | — | 0 |
| Soft budget (alert threshold) | Warn before the cap is reached. | **Not used.** E-mail alerts are Enterprise. | — | The OS warns at 80 % from the spend it reads. | On. | Threshold. | 4 |
| `rpm_limit`, `tpm_limit`, `max_parallel_requests` | Limit requests per minute, tokens per minute and calls at the same time. | **Used.** Shared key: 120, 200,000 and 8. System keys: 120 and 200,000, no parallel limit, and the numbers are fixed in code. On main after this commit: PR #88 (merged) raises the shared key to 300 requests and 1,000,000 tokens per minute; PR #92 (merged) takes system-key caps from the chart (`osUI.agentSystemKey`, default 300 and 1,000,000). | `values.yaml:402-405`; `live.ts:82-87`; `live-clients.ts:212-218` | All three on every key, from settings, not from code. | 60, 200,000 and 4 per system. | Up to the domain team's limits. | 0 (on main: PR #88, PR #92) |
| Budget reservation | The gateway sets aside the largest possible cost of a call before it runs. | **Used** in effect: `max_tokens` is always sent. The version that introduced reservation was not confirmed. | `core/runtime/runtime.ts:185-186` | Keep sending `max_tokens` on every call. | Automatic. | None. | — |
| Temporary budget increase | A time-boxed raise of a cap. | **Blocked.** Enterprise. | — | An admin raises the budget and lowers it again. | — | — | — |
| What happens at a rate limit | The gateway answers HTTP 429 with a `retry-after` header. It does not queue. | **Not used.** The OS reads neither the header nor the remaining-quota headers. The call fails at once. The chart comment "graceful queueing" is wrong. | `core/runtime/runtime.ts:224-232`; `values.yaml:402` | Tell "out of budget" from "too fast". Wait and retry on "too fast"; park the run if it lasts. | On. | Number of waits, within the admin cap. | 0 (on main: PR #91, merged, waits out a rate-limit 429 with a visible event) |

## Routing

| Feature | What it is for | In the OS today | Where | Target | Simple mode default | Developer mode override | Phase |
|---|---|---|---|---|---|---|---|
| Model aliases (`model_name`) | Give models stable names that hide the provider's name. | **Used.** `sovereign-default`, `sovereign-mock`, `sovereign-reasoning`, `sovereign-embed`; the STACKIT overlay adds more. | `values.yaml:485-506`; `values.stackit-managed.yaml:86-128` | Keep. | Role aliases. | Pick an alias per agent from the allowed list. | — |
| Routing strategy `simple-shuffle` | Spread calls across healthy deployments. | **Used.** | `values.yaml:512` | Keep. LiteLLM recommends it for production. | — | — | — |
| `fallbacks` | Try another model when one fails. | **Used** in the STACKIT overlay only. The cheap model falls back to the expensive one. A system key that does not list the fallback model may be refused (suspected defect S1). | `values.stackit-managed.yaml:134-137` | Keep, but only to models on the key's list. Make the cost jump visible. | Gateway default. | Fallback per agent. | 0, 4 |
| `context_window_fallbacks` | Switch to a model with a larger window when the input is too long. | **Not used.** | — | Not planned. The input budget (Phase 1) keeps calls far below the window. | — | — | — |
| `content_policy_fallbacks` | Switch model when a provider's content filter refuses. | **Not used.** | — | Out of scope. Not relevant for the models in use. | — | — | — |
| Gateway retries (`num_retries`) | Retry a failed provider call inside the gateway. | **Used.** 3 retries. These cover provider errors, not the gateway's own rate-limit refusals. The OS on top retries nothing. | `values.yaml:513`; `core/runtime/runtime.ts:224-232` | One layer owns retries: the engine. Agent calls ask the gateway for at most one retry. | Automatic. | None. | 0, 2 |
| Cooldowns (`allowed_fails`, `cooldown_time`) | Rest a failing deployment for a while. | **Used.** 3 failures, 60 seconds. Each alias has one deployment, so a cooldown takes the whole alias away for a minute. | `values.yaml:515-516` | Shorten the cooldown for single-deployment aliases. | — | — | 0 |
| Timeouts (`timeout`, `stream_timeout`) | Give up on a slow model call. | **Used.** 120 seconds per attempt, 300 for the reasoning model. The OS's own limit is 240 seconds, so the OS can give up while the gateway is still retrying. | `values.yaml:514`, `:502`; `core/runtime/runtime.ts:153` | Make the limits consistent: the OS waits at least as long as the gateway's worst case. | Automatic. | Per agent, within the admin cap. | 0 |
| Pre-call checks with `model_info.max_input_tokens` | Refuse or re-route a call that cannot fit the model. | **Not used.** No `model_info` on any alias. | `values.yaml:485-506` | Declare the real sizes per alias and switch the checks on. | — | — | 0 |
| Vision capability filter (`supports_vision`) | Keep image requests away from models that cannot see. | **Hand-built.** The OS has its own explicit admin list of models that may be sent images. That list is a data-protection decision, not a capability guess. Nothing sends an image yet. | `core/models/capabilities.ts`; `values.yaml:1316-1324` | Keep the OS list as the authority (owner decision: images only to the EU-hosted Qwen3-VL, by explicit admin list). Also declare `supports_vision` in the gateway as a second barrier. | Admin list. | None. | 0 |
| Request priority (scheduler) | Let important calls go first. | **Not used.** | — | Out of scope. LiteLLM calls it beta, "for testing only". | — | — | — |
| Admission queue (`max_in_flight_requests_per_worker`) | Bound how many calls a gateway worker handles at once. | **Not used.** | — | Not planned. | — | — | — |

## What a request can ask for

| Feature | What it is for | In the OS today | Where | Target | Simple mode default | Developer mode override | Phase |
|---|---|---|---|---|---|---|---|
| Streaming | Deliver the reply word by word. | **Not used.** Never requested by agent runs. | `core/runtime/runtime.ts:180-190` | On for the final answer of the agent the user is watching. | On. | None. | 2 |
| Tools and `tool_choice` | Let the model call tools; optionally force it to. | **Used** with `auto` only. | `core/runtime/runtime.ts:187-190` | Force a call where one is required. | Automatic. | auto, required, none per agent. | 2 |
| `parallel_tool_calls` | Say whether the model may ask for several tools at once. | **Not used.** Not sent. | `core/runtime/runtime.ts:180-190` | Sent explicitly. | Off with write tools; on for read-only agents. | Per agent. | 2 |
| `response_format` with a schema | Make the reply follow a declared structure. | **Not used** on the run path. | — | Used for structured answers and "for each" items, with the gateway's schema check and one repair turn in the OS. | Off, except "for each" items. | Schema per agent. | 2 |
| `drop_params` | Silently drop settings a model does not support. | **Used** (`true`). Side effect: a model without tool support has `tools` dropped silently and answers in prose (suspected defect S6). | `values.yaml:525` | Keep, and have Build test once that each alias really accepts tools. | — | — | 0 |
| Reasoning (`reasoning_effort`, `reasoning_content`) | Control and read the model's thinking. | **Not used.** Thinking that arrives as `<think>` text is removed by hand. | `tabs/agents/lib/agent-chat-response.ts:58-68` | Read `reasoning_content` and keep it out of answers and traces. | Model default. | Effort per agent. | 2 |
| Vision (image parts) | Send images to a model. | **Not used.** The list of models that may be sent images exists and is live, but no model call sends an image yet (`CHANGELOG.md`, Unreleased: "nothing sends one yet"). | `core/models/capabilities.ts` | When images are sent: only to models on the admin list, with the decided limits: 3 images in view, 10 per run, about 1300 px, 5 PDF pages per run, never from restricted files. | As decided. | None. | Later |
| Token counting | Count tokens before sending. | **Hand-built.** The OS estimates characters divided by four. | `tabs/agents/lib/build/agentic-graph.ts:22-24` | Keep the estimate for budgeting. Measure real use from the gateway's reply for reporting. | — | — | 1 |
| `/model/info` | Tell clients what each model can do and what it costs. | **Used** for the admin view only. Sizes and capabilities used by runs are fixed in OS code. | `core/infra/litellm-admin.ts:170`; `core/models/context-windows.ts:46-52` | Runs read sizes and capabilities from here, with the OS list as a fallback. | — | — | 0 |

## Caching, spend, guardrails, logging, administration

| Feature | What it is for | In the OS today | Where | Target | Simple mode default | Developer mode override | Phase |
|---|---|---|---|---|---|---|---|
| Response cache | Answer a repeated request from memory. | **Used** for classification and embeddings only. Agent runs never opt in. | `values.yaml:526-538` | Keep. Not for agent runs. | Off. | On for a step marked "same input, same answer". | Later |
| Provider prompt caching | Let the provider reuse an unchanged prompt opening. | **Not used.** Whether STACKIT supports it was not confirmed. | — | Ask STACKIT. If available, the stable prompt opening from Phase 1 benefits at once. | — | — | Later |
| Spend tracking | Record cost per key, user and tag. | **Used.** The admin view reads keys, teams and a spend report. The spend report endpoint it reads (`/global/spend/report`) is listed as Enterprise in the research; whether it returns data on the deployed gateway was not checked. | `core/infra/litellm-admin.ts:170-177` | Read spend per run id from the open-source endpoints (`/spend/logs`, `/spend/tags`). | — | — | 1 |
| Custom prices in the gateway (`input_cost_per_token`) | Tell the gateway what a model costs, so budgets can count. | **Hand-built.** The OS has its own price book. The gateway has no prices for the aliases. Without them the gateway may count every call as free, and no budget would ever trigger. Not verified live. | `values.yaml:1427`; `values.yaml:485-506` | One price list, written once, rendered into both the gateway and the OS. | — | — | 0 |
| Spend-log retention | Delete old spend rows; keep prompts out of them. | **Not used.** Not set in the chart. Prompts are not stored in spend logs by default. | `values.yaml:508-548` | 90 days. Prompts stay off. | — | — | 3 |
| Guardrails | Check or mask requests and replies at the gateway. | **Not used.** | — | Off for now. The open-source personal-data masking for logs is an option later. Per-key guardrail control is Enterprise. | Off. | None. | Later |
| Custom hooks | Run own code inside the gateway. | **Not used.** | — | Out of scope. It would put OS logic inside the gateway image. | — | — | — |
| `langfuse` callback (the older one) | Send a record of every call to Langfuse. | **Misused.** It logs the full prompt and reply into the same trace where the OS logs a redacted record of the same call. Two records per call, one unredacted. | `values.yaml:519-524`; `core/runtime/runtime.ts:196-202` | Replace with the newer `langfuse_otel` callback, content capture off. | — | — | 3 |
| `langfuse_otel` callback | The current way to send call records to Langfuse, linked by a standard trace header. | **Not used.** Needs LiteLLM 1.109 or later. | — | Use it. The gateway owns the one record per model call. | On, no content. | Content capture per system, only with tenant-admin consent. | 3 |
| Log redaction (`turn_off_message_logging`) | Keep prompt and reply text out of the gateway's logs. | **Not used.** Not set. | `values.yaml:519-538` | Set it now, before the callback change. | On. | — | 0 |
| Models stored in the database | Let an admin add models in the console. | **Used.** Note: from 1.103.0 a setting in the config file wins over the database value. | `values.yaml:539-542` | Keep. Re-check admin-added models after the upgrade. | — | — | 0 |
| Health endpoints | Tell whether the gateway is up. | **Used.** Build asks `/health/readiness`. | `live-clients.ts:206-209` | Keep. | — | — | — |
| Pass-through endpoints | Forward other provider routes. | **Not used.** | — | Out of scope. Authentication on them is Enterprise. | — | — | — |
| MCP gateway | Offer tool servers through the gateway. | **Used** for one server (`sovereign_query`). Agent tools do not go through it; they are called inside the OS. | `values.yaml:544-548`; `tabs/agents/lib/build/os-tools.ts:697-702` | Keep agent tools inside the OS so identity and policy stay in one place. Do not grow a second tool registry. | — | — | — |
| Master key kept for administration only | Keep the all-powerful key away from normal calls. | **Used** correctly. A test checks that only four files may name it and that a real run does not send it. | `core/infra/litellm-credential.ts:96-116`; `core/runtime/runtime.test.ts:241-252` | Keep (owner decision). | — | — | — |
| Salt key (`LITELLM_SALT_KEY`) | A separate key that encrypts model credentials stored in the gateway's database. | **Not used.** Without it the master key is also the encryption key, so the master key cannot be changed safely. | `charts/sovereign-agentic-os/templates/base/litellm/credentials.yaml` | Set it once, before the next stored model, and never change it. | — | — | 0 |
| Network exposure | Who can reach the gateway at all. | **Misused.** The gateway has its own public hostname (live). The chart creates that route whenever a hostname is set for it. | `charts/sovereign-agentic-os/templates/base/ingress.yaml:31-39` | In-cluster only. Admins reach the console through the OS at `/tools/litellm`. | — | — | 0 (owner decision 2, pending) |
| Version pin and image verification | Run a known, supported, verified version. | **Used**: the version is pinned. It is far behind. | `charts/sovereign-agentic-os/Chart.yaml:52-55` | Upgrade, pin by digest, re-test tags and budgets after each upgrade. | — | — | 0 |
| Single sign-on, JWT login, audit logs, IP allow-lists, secret managers | Enterprise access controls. | **Blocked.** Enterprise (single sign-on is free up to five users). | — | Not needed: the OS signs admins in server-side. | — | — | — |

## Sources

From the research of 2026-11-19.

- Licence boundary: https://docs.litellm.ai/docs/enterprise, https://docs.litellm.ai/docs/enterprise/moving_from_oss
- Keys and budgets: https://docs.litellm.ai/docs/proxy/virtual_keys, https://docs.litellm.ai/docs/proxy/users, https://docs.litellm.ai/docs/proxy/customers, https://docs.litellm.ai/docs/proxy/alerting
- Limits and headers: https://docs.litellm.ai/docs/proxy/response_headers; LiteLLM source at tags v1.90.0 and v1.110.1 (`litellm/proxy/hooks/parallel_request_limiter_v3.py`)
- Routing: https://docs.litellm.ai/docs/routing, https://docs.litellm.ai/docs/proxy/reliability, https://docs.litellm.ai/docs/proxy/timeout, https://docs.litellm.ai/docs/scheduler
- Requests: https://docs.litellm.ai/docs/completion/function_call, https://docs.litellm.ai/docs/completion/json_mode, https://docs.litellm.ai/docs/completion/drop_params, https://docs.litellm.ai/docs/reasoning_content, https://docs.litellm.ai/docs/completion/vision, https://docs.litellm.ai/docs/count_tokens, https://docs.litellm.ai/docs/proxy/model_management
- Caching, spend, guardrails: https://docs.litellm.ai/docs/proxy/caching, https://docs.litellm.ai/docs/completion/prompt_caching, https://docs.litellm.ai/docs/proxy/custom_pricing, https://docs.litellm.ai/docs/proxy/spend_logs_deletion, https://docs.litellm.ai/docs/proxy/guardrails/quick_start, https://docs.litellm.ai/docs/proxy/guardrails/pii_masking_v2, https://docs.litellm.ai/docs/proxy/call_hooks
- Logging and tracing: https://docs.litellm.ai/docs/observability/langfuse_integration, https://docs.litellm.ai/docs/observability/langfuse_to_otel_v2_migration, https://docs.litellm.ai/docs/proxy/logging
- Administration and security: https://docs.litellm.ai/docs/proxy/prod, https://docs.litellm.ai/docs/proxy/master_key_rotations, https://docs.litellm.ai/docs/proxy/security_best_practices, https://docs.litellm.ai/docs/proxy/health, https://docs.litellm.ai/docs/proxy/pass_through, https://docs.litellm.ai/docs/mcp, https://docs.litellm.ai/blog/security-update-march-2026
- Advisories: https://github.com/BerriAI/litellm/security/advisories

Points the research could not confirm: the versions that introduced `budget_limits`, budget
reservation, the default vision filter and rate-limit fallbacks; whether open-source 1.90.0 reads
`metadata.model_max_budget` on a key; which budget alerts are open source; STACKIT's support for
prompt caching and its image size limits; whether GHSA-w4c7-34wj-hqm8 affects a proxy without an
Enterprise licence.
