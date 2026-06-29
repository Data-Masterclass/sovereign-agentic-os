#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
"""Trino `query` MCP tool — the GOVERNED query engine over the lakehouse marts.

Runs read-only SQL against CENTRAL TRINO (Iceberg tables on the Polaris REST
catalog). Two governance layers apply, neither in this process:
  * OPA gates tool ACCESS at the LiteLLM MCP gateway (per-key, default-deny).
  * Trino enforces ROW/COLUMN governance (the Trino->OPA plugin: row filter by
    domain, column mask by sensitivity) on every read.
There is NO embedded DuckDB here — DuckDB is the personal/sandbox lane, kept
behind Trino's governance boundary (never a second door to governed marts).

Exposed as an MCP server (streamable-http at /mcp) for the gateway, plus plain
HTTP /query + /health for direct use and probes.
"""
import os

from mcp.server.fastmcp import FastMCP
from starlette.requests import Request
from starlette.responses import JSONResponse

import trino

PORT = int(os.environ.get("PORT", "8000"))
TRINO_HOST = os.environ.get("TRINO_HOST", "trino")
TRINO_PORT = int(os.environ.get("TRINO_PORT", "8080"))
TRINO_CATALOG = os.environ.get("TRINO_CATALOG", "iceberg")
TRINO_SCHEMA = os.environ.get("TRINO_SCHEMA", "analytics")
# The Trino session user the OPA row/column plugin governs. The gateway authorizes
# tool access per agent key; the query runs as this governed domain principal.
TRINO_USER = os.environ.get("TRINO_USER", "query-agent")


def _connect(principal: str | None = None):
    return trino.dbapi.connect(
        host=TRINO_HOST,
        port=TRINO_PORT,
        user=principal or TRINO_USER,
        catalog=TRINO_CATALOG,
        schema=TRINO_SCHEMA,
        http_scheme=os.environ.get("TRINO_HTTP_SCHEME", "http"),
    )


def run_query(sql: str, principal: str | None = None) -> dict:
    conn = _connect(principal)
    cur = conn.cursor()
    cur.execute(sql)
    rows = cur.fetchall()
    cols = [d[0] for d in cur.description] if cur.description else []
    return {
        "engine": "trino",
        "catalog": TRINO_CATALOG,
        "schema": TRINO_SCHEMA,
        "columns": cols,
        "rows": [[str(v) for v in r] for r in rows],
        "row_count": len(rows),
    }


mcp = FastMCP("sovereign-query", host="0.0.0.0", port=PORT)


@mcp.tool()
def query(sql: str) -> dict:
    """Run a read-only SQL query over the governed lakehouse marts via central
    Trino (e.g. `select order_date, revenue from daily_revenue order by 1`).
    Trino enforces row/column governance (OPA) on every read. Returns columns+rows.
    The governed query engine of the Sovereign Agentic OS."""
    return run_query(sql)


@mcp.tool()
def list_tables() -> dict:
    """List the tables available to query in the current Trino schema."""
    return run_query("show tables")


@mcp.custom_route("/health", methods=["GET"])
async def health(_req: Request):
    return JSONResponse({"status": "ok", "engine": "trino",
                         "host": TRINO_HOST, "catalog": TRINO_CATALOG,
                         "schema": TRINO_SCHEMA})


@mcp.custom_route("/query", methods=["POST"])
async def http_query(req: Request):
    body = await req.json()
    sql = body.get("sql", "")
    if not sql:
        return JSONResponse({"error": "missing sql"}, status_code=400)
    try:
        # Optional per-call identity so Trino's OPA plugin governs the right user.
        return JSONResponse(run_query(sql, body.get("principal")))
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"error": str(e)}, status_code=500)


if __name__ == "__main__":
    print(f"[query] Trino MCP (/mcp) + HTTP (/health,/query) on :{PORT} "
          f"(trino={TRINO_HOST}:{TRINO_PORT}, catalog={TRINO_CATALOG}, "
          f"schema={TRINO_SCHEMA})")
    mcp.run(transport="streamable-http")
