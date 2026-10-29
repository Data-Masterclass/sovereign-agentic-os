# Langfuse — observability & tracing

**What it is:** Langfuse v3 (MIT) records every agent action — LLM calls, tool calls,
retrievals — as **traces**, with token/cost usage and latency. It's the default
Administrator-style console and the "Monitoring" surface of the OS. Backed by Postgres
(metadata), ClickHouse (analytics), Valkey (queue) and MinIO (event blobs).

## Access
```bash
kubectl -n agentic-os port-forward svc/agentic-os-langfuse-web 3000:3000
# http://localhost:3000
```
**Login:** `admin@datamasterclass.com` / `langfuse-local-dev-admin`

## How to use it
- **See traces:** project **Agent Core** → *Tracing → Traces*. Each `rag-agent` /
  `poet-agent` run shows its spans; `litellm-*` traces are the gateway calls.
- **Generate fresh traces:** run an agent (see the Sample RAG agent doc), then refresh.
- **API (server-side, project-scoped key):**
  ```bash
  curl -u pk-lf-localdev0000public:sk-lf-localdev0000secret \
    http://localhost:3000/api/public/traces?limit=5
  ```
- **Evals / datasets / scores:** create datasets and run evaluations from the UI (the full
  Langfuse feature set is available).

## Project keys (demo)
- Public: `pk-lf-localdev0000public`  ·  Secret: `sk-lf-localdev0000secret`
- Host (in-cluster): `http://agentic-os-langfuse-web:3000`
These are injected into the agents + LiteLLM so traces flow automatically.

## FAQ
**Q: I don't see traces.** Run an agent first; ingestion is async (a few seconds via the
worker). Check the `agentic-os-langfuse-worker` pod is running.
**Q: Per-project RBAC?** That's a Langfuse `/ee` feature (not bundled); domain scoping is
enforced in the OS app layer using each domain's project-scoped key.
**Q: Is telemetry phoning home?** No — `telemetryEnabled: false` (sovereign/offline).
**Q: Where do the raw event blobs live?** In MinIO (`langfuse` bucket); metadata in Postgres,
analytics in ClickHouse.
