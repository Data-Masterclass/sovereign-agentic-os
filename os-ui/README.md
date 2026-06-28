# Sovereign Agentic OS UI

The Next.js (app router + TypeScript) **front door** for the Sovereign Agentic OS: the OS
shell (left sidebar with the canonical tabs from `stackit/os-application.md`, plus a
**Platform** group) with the surfaces wired to the **live in-cluster backends** via
**server-side API routes** — so credentials and project keys stay on the server and never
reach the browser.

## Tabs

| Tab | Status | Backend (server-side) |
|---|---|---|
| **Home** | live | overview + golden paths + a live **stack-status strip** (pings 8 backends) |
| **Agents** (Chat) | live | `sample-agent` `GET /ask?q=` → answer + retrieved source titles |
| **Knowledge** | live | OpenSearch `POST /{index}/_search` → ranked RAG hits (embedding excluded) |
| **Structured Data** | live | query-tool `POST /query` → columns/rows, + a clickable Iceberg table browser |
| **Software** | live | Forgejo `GET /api/v1/...` (basic auth) → repos + `demo-app` CI runs (push→CI→deploy) |
| **Monitoring** | live | Langfuse `GET /api/public/traces` (basic auth) → recent traces |
| **Governance** | live | OPA `grants` + `POST /v1/data/agentic/authz/allow` → live default-deny grants matrix |
| **Dashboards** | link | Superset (`SUPERSET_URL`) |
| **Gateway** (Platform) | live | LiteLLM `GET /v1/models` + `/v1/mcp/tools` (Bearer) → models + MCP tools |
| **Orchestration** (Platform) | live | Dagster GraphQL → dbt assets + recent runs |
| **Consoles** (Platform) | launchpad | Langfuse / Superset / Argo CD / OpenMetadata / Dagster / Forgejo access cards |
| Strategy, Big Bets, Science, Metrics, Unstructured Data, Connections, Marketplace, Settings | stub | shell placeholders |

## Architecture

```
browser ──> /api/status        ──> health-pings 8 backends (up/down strip)
        ──> /api/chat           ──> SAMPLE_AGENT_URL/ask?q=
        ──> /api/knowledge?q=   ──> OPENSEARCH_URL/{index}/_search
        ──> /api/query          ──> QUERY_TOOL_URL/query
        ──> /api/tables         ──> QUERY_TOOL_URL/query (catalog list)
        ──> /api/software       ──> FORGEJO_URL/api/v1/... (basic auth)
        ──> /api/gateway        ──> LITELLM_URL/v1/models + /v1/mcp/tools (bearer)
        ──> /api/policy         ──> OPA_URL/v1/data/grants + .../authz/allow
        ──> /api/orchestration  ──> DAGSTER_URL/graphql
        ──> /api/traces         ──> LANGFUSE_URL/api/public/traces (basic auth)
```

All credentials/keys stay server-side. Backend base URLs are env-configurable
(see `lib/config.ts`); defaults are the in-cluster Service names, so the same image runs
in-cluster and locally (pointed at port-forwards).

## Develop

```bash
npm install
npm run dev    # http://localhost:3000  (set the env vars below to reach real backends)
npm run build  # production build (output: 'standalone')
```

## Deploy

Built as `images/os-ui/Dockerfile` (multi-stage, non-root, standalone) and deployed by
`charts/sovereign-agentic-os/templates/os-ui/os-ui.yaml`. See **`INTEGRATION.md`** for the
exact `values.yaml` / build-images entries the chart owner must add (incl. the new
`osUI.*` keys for OpenSearch, Forgejo, LiteLLM, OPA, Dagster, and the console URLs).

## Env vars (all optional; defaults = in-cluster Service names)

See `INTEGRATION.md` for the full table and a ready-to-run `docker run` command. The new
ones added in this build: `OPENSEARCH_URL`, `KNOWLEDGE_INDEX`, `FORGEJO_URL`,
`FORGEJO_USER`, `FORGEJO_PASSWORD`, `LITELLM_URL`, `LITELLM_MASTER_KEY`, `OPA_URL`,
`DAGSTER_URL`, plus browser-reachable console URLs (`LANGFUSE_CONSOLE_URL`,
`FORGEJO_CONSOLE_URL`, `ARGOCD_URL`, `OPENMETADATA_URL`, `DAGSTER_CONSOLE_URL`).
