# DuckDB query tool (MCP)

**What it is:** The **default query engine** of the OS — a bespoke server that runs **DuckDB
SQL over Iceberg** tables (catalog metadata in CloudNativePG, data on object storage). It's
registered in the **LiteLLM MCP gateway** as the `query` tool (OPA-gated), so agents can query
the lakehouse. (Trino/Spark are optional scale modules, off by default.)

## Access
- **Direct HTTP:**
  ```bash
  kubectl -n agentic-os run q --rm -i --restart=Never --image=curlimages/curl:8.11.1 -- \
    curl -sS http://query-tool:8000/query -H "Content-Type: application/json" \
    -d '{"sql":"select customer, sum(amount) from orders group by 1"}'
  ```
- **Via the LiteLLM MCP gateway** (how agents call it): connect an MCP client to
  `http://agentic-os-litellm:4000/mcp` with a LiteLLM key; call tool `sovereign_query-query`.

## How to use it
- Query the seeded Iceberg table `analytics.orders` (5 demo rows). `GET /tables` lists tables.
- Add tables with the bootstrap (`bootstrap.py`) or pyiceberg; they appear automatically.

## FAQ
**Q: Why is the catalog in Postgres, not Polaris?** Polaris is deployed as the REST catalog,
but its S3 credential vending needs AWS STS (absent in the local S3 stand-in). So the query
path uses pyiceberg's SQL catalog **in CloudNativePG** (still "metadata in CNPG") + static-cred
S3. On STACKIT (with STS) Polaris vends directly.
**Q: DuckDB vs Trino?** DuckDB is the default (embedded, fast at normal scale). Enable
`trino.enabled` for federation/scale.
**Q: Is it OPA-gated?** The `query` tool is in the OPA grants; LiteLLM enforces per-key MCP access.
