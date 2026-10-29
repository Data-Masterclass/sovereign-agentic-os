# LiteLLM — model & MCP gateway

**What it is:** LiteLLM (MIT) is the **one governed endpoint** agents call for both **models**
and **MCP tools**. It enforces per-key access + cost caps, logs every call (to Langfuse), and
fronts the registered MCP tool servers (the governed Trino `query` tool, etc.). DB-backed (CNPG
`litellm`) so the admin UI, virtual keys and spend tracking work.

## Access
```bash
kubectl -n agentic-os port-forward svc/agentic-os-litellm 4000:4000
# Admin UI: http://localhost:4000/ui    API docs: http://localhost:4000/docs
```
**Login:** `admin` / `litellm-admin-local-dev`  ·  **Master key:** `sk-litellm-local-dev-master`

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
