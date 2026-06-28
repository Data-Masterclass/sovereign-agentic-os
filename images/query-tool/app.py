#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
"""
DuckDB `query` MCP tool — the default query engine over the lakehouse.

Runs DuckDB SQL over Iceberg tables (catalog in CloudNativePG, data on object
storage). Exposed as an MCP server (streamable-http at /mcp) so the LiteLLM MCP
gateway can register it and agents can call it (per-key access + OPA). Also keeps
plain HTTP /query + /health for direct use and probes.
"""
import os

from mcp.server.fastmcp import FastMCP
from starlette.requests import Request
from starlette.responses import JSONResponse

import duckdb
import common as C

PORT = int(os.environ.get("PORT", "8000"))


def _load_con():
    cat = C.catalog()
    con = duckdb.connect()
    tables = []
    for ident in cat.list_tables(C.NAMESPACE):
        name = ident[-1]
        arrow = cat.load_table(ident).scan().to_arrow()
        con.register(name, arrow)
        con.register(f"{C.NAMESPACE}_{name}", arrow)
        tables.append(f"{C.NAMESPACE}.{name}")
    return con, tables


def run_query(sql: str) -> dict:
    con, tables = _load_con()
    res = con.execute(sql)
    cols = [d[0] for d in res.description]
    rows = [[str(v) for v in r] for r in res.fetchall()]
    return {"engine": "duckdb", "tables": tables, "columns": cols,
            "rows": rows, "row_count": len(rows)}


mcp = FastMCP("sovereign-query", host="0.0.0.0", port=PORT)


@mcp.tool()
def query(sql: str) -> dict:
    """Run a read-only DuckDB SQL query over the lakehouse Iceberg tables
    (e.g. `select customer, sum(amount) from orders group by 1`). Returns columns
    and rows. The default query engine of the Sovereign Agentic OS."""
    return run_query(sql)


@mcp.tool()
def list_tables() -> dict:
    """List the Iceberg tables available to query in the lakehouse."""
    cat = C.catalog()
    return {"tables": [".".join(i) for i in cat.list_tables(C.NAMESPACE)]}


@mcp.custom_route("/health", methods=["GET"])
async def health(_req: Request):
    return JSONResponse({"status": "ok", "warehouse": C.BASE_LOCATION,
                         "namespace": C.NAMESPACE})


@mcp.custom_route("/query", methods=["POST"])
async def http_query(req: Request):
    body = await req.json()
    sql = body.get("sql", "")
    if not sql:
        return JSONResponse({"error": "missing sql"}, status_code=400)
    try:
        return JSONResponse(run_query(sql))
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"error": str(e)}, status_code=500)


if __name__ == "__main__":
    print(f"[query] MCP (/mcp) + HTTP (/health,/query) on :{PORT} "
          f"(warehouse={C.BASE_LOCATION}, ns={C.NAMESPACE})")
    mcp.run(transport="streamable-http")
