# Governed `query` tool (MCP, Trino)

**What it is:** The **governed query engine** of the OS — a bespoke server that runs read-only
SQL **THROUGH central Trino** over the Iceberg marts (Polaris REST catalog, object storage). It's
registered in the **LiteLLM MCP gateway** as the `query` tool (OPA-gated), so agents can query the
governed lakehouse. **OPA gates tool access** at the gateway; **Trino enforces row/column
governance** (the Trino→OPA plugin) on every read. DuckDB is **not** on this path — it is scoped to
the personal/sandbox lane (see `sandbox-duckdb`).

## Access
- **Direct HTTP:**
  ```bash
  kubectl -n agentic-os run q --rm -i --restart=Never --image=curlimages/curl:8.11.1 -- \
    curl -sS http://query-tool:8000/query -H "Content-Type: application/json" \
    -d '{"sql":"select order_date, revenue from daily_revenue order by 1"}'
  ```
- **Via the LiteLLM MCP gateway** (how agents call it): connect an MCP client to
  `http://agentic-os-litellm:4000/mcp` with a LiteLLM key; call tool `sovereign_query-query`.

## How to use it
- Query the dbt-trino marts, e.g. `analytics.daily_revenue` (the Sales worked example). The
  `list_tables` tool / `show tables` lists the schema's tables.
- Marts are built by **dbt-trino** (Iceberg on Polaris); Cube + Superset + this tool all read the
  SAME tables through Trino, so the numbers can't drift.

## Governance
- **Tool access:** the `query` tool is in the OPA grants; LiteLLM enforces per-key MCP access.
- **Row/column:** Trino's OPA plugin (package `trino`) applies a **row filter by domain** and a
  **column mask by sensitivity** to every read — a cross-domain read is masked while the owning
  domain sees it. The query forwards the caller's principal so Trino governs the right identity.

## FAQ
**Q: Trino vs DuckDB?** Trino is the single governed engine for all shared marts (federation,
Iceberg read/write/maintenance, OPA row/column). DuckDB is kept ONLY for the personal/sandbox lane
(`sandbox-duckdb`), behind Trino's governance — never a second door to governed marts.
**Q: Local creds?** On kind, Trino uses static S3 creds (Polaris S3 credential vending needs AWS
STS, absent in the MinIO stand-in). On STACKIT, vended credentials are enabled.
