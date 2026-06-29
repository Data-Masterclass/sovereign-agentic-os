# Model server — the default self-hosted LLM (+ routing)

**What it is:** A CPU, OpenAI-compatible LLM runtime (Ollama/llama.cpp) that serves a small,
permissively-licensed model — **Ministral 3 3B (Q4, Apache-2.0)** by default — as the **default
chat backend of the Sovereign Agentic OS**: the light tier for chat, coding, and tool-selection.
It **replaces the offline mock LLM** for chat: fully offline, **no provider key**, nothing leaves
the sovereign boundary. LiteLLM routes `sovereign-default` (and the back-compat `sovereign-mock`
alias) here and **load-balances across N replicas**.

## The model strategy (routing)

LiteLLM is the one governed endpoint; every model_name resolves through it:

| model_name          | backend                                   | role                                            |
|---------------------|-------------------------------------------|-------------------------------------------------|
| `sovereign-default` | self-hosted Ministral 3 3B (this component) | **default**, light/cheap-first tier (chat, coding, tool-selection) |
| `sovereign-mock`    | self-hosted Ministral 3 3B (alias)         | back-compat name existing agents/UI default to  |
| `sovereign-embed`   | mock-model (deterministic 384-dim)         | offline embeddings for RAG                      |
| `sovereign-vision`  | STACKIT AI Model Serving (Qwen3-VL 235B)   | **vision** inputs                               |
| `sovereign-premium` | STACKIT AI Model Serving (Qwen3-VL 235B)   | **last-resort** fallback (pay-per-token)        |

**Fallback chain:** self-hosted Ministral 3 replicas → *(optional)* bigger self-host → **STACKIT (last
resort)**. STACKIT fires **only** when every self-hosted route is unreachable/overloaded, **or**
when the caller selects the vision route. The router (`litellm.proxy_config.router_settings`)
adds `num_retries`, `timeout`, circuit-breaking (`allowed_fails` + `cooldown_time`), and
`simple-shuffle` load-balancing. **Escalation** (failed verifier / low confidence / vision /
high-stakes) is the agent choosing a heavier `model_name`; LiteLLM logs **model + cost per call to
Langfuse**, so the tier and spend are visible in **Monitoring**.

**STACKIT catalog id (confirmed, STACKIT docs → available-shared-models):**
`Qwen/Qwen3-VL-235B-A22B-Instruct-FP8`, OpenAI-compatible base
`https://api.openai-compat.model-serving.eu01.onstackit.cloud/v1`.

## Config alternatives & toggles (chart values)

- **Default model:** `modelServer.model` — **Ministral 3 3B (Apache-2.0)** by default. Keep to
  permissively-licensed weights, and size `modelServer.resources` to the tag if you swap it.
- **Replicas:** `modelServer.replicas` (N pods behind LiteLLM load-balancing).
- **Optional bigger self-host (OFF by default):** `modelServer.big.enabled` — a **GPU vLLM**
  serving a larger model (Qwen 3.6 / Mistral) registered as `sovereign-big`, sitting **below**
  STACKIT in the fallback chain. Needs a GPU node pool; enabling it means adding `sovereign-big`
  to the model_list + fallbacks (see values.yaml comments).
- **STACKIT premium (OFF by default):** `stackitPremium.enabled` — the key is supplied via
  **External Secrets** (`stackitPremium.externalSecrets.enabled`), never inline. The **hard cost
  guardrail** is a dedicated per-model spend cap on the agent virtual key
  (`litellmAgentKey.modelMaxBudget`) plus per-key rate limits
  (`rpmLimit` / `tpmLimit` / `maxParallelRequests`).

## Benchmark / scale (model-benchmark.md)

A Ministral 3 3B Q4 CPU replica needs **~3–4 GB RAM**. For **~30 concurrent users** run **~3–5
replicas**, **or** a single small GPU. Local kind runs **1 replica** (`values.local.yaml` /
`values.selfcontained.yaml`); the product default (`values.yaml`) is **2**, scale up on a sized
node.

## Notes

- **First request per pod** triggers a one-time model **pull** (needs egress to the model registry
  once). Steady state is **fully offline**. Air-gap by baking weights into a bespoke image, or set
  `modelServer.persistence.enabled` with an RWX class for a shared, no-re-pull model cache.
- **Private overlay:** register extra self-hosted endpoints and extend the fallback chain via a
  gitignored `values.private.yaml` — see `values.private.example.yaml`. Public defaults are never
  edited.
