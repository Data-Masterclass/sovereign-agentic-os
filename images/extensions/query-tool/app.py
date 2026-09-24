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
import asyncio
import hmac
import os

from mcp.server.fastmcp import FastMCP
from starlette.requests import Request
from starlette.responses import JSONResponse

import trino
import trino.exceptions

from execute_guard import ExecuteError, connect_kwargs, guard, guard_read

PORT = int(os.environ.get("PORT", "8000"))
TRINO_HOST = os.environ.get("TRINO_HOST", "trino")
TRINO_PORT = int(os.environ.get("TRINO_PORT", "8080"))
TRINO_CATALOG = os.environ.get("TRINO_CATALOG", "iceberg")
# Default session schema. `sales` is the live Northpeak demo domain schema
# (iceberg.sales holds the materialized marts). The former `analytics` literal was
# a dead schema — killed by the warehouse re-provision, never recreated — which is
# what made every unqualified query 500 (SCHEMA_NOT_FOUND). Callers can override
# per request with an explicit `schema` (os-ui passes the caller's domain) so the
# session targets the RIGHT catalog.schema instead of a hardcoded literal.
TRINO_SCHEMA = os.environ.get("TRINO_SCHEMA", "sales")
# The Trino session user the OPA row/column plugin governs. The gateway authorizes
# tool access per agent key; the query runs as this governed domain principal.
TRINO_USER = os.environ.get("TRINO_USER", "query-agent")

# Service-to-service bearer (defense-in-depth). This process trusts the
# principal/role/domains in the request body and is only meant to be called by os-ui;
# the NetworkPolicies are the primary boundary, but network reach alone must not equal
# identity. When SERVICE_BEARER_TOKEN is set, every data endpoint requires a matching
# `Authorization: Bearer <token>` (constant-time compared). When UNSET, the check is
# skipped (fail-open by design — see startup warning). /health is always open.
SERVICE_BEARER_TOKEN = os.environ.get("SERVICE_BEARER_TOKEN", "")


def _bearer_ok(req: Request) -> bool:
    """Constant-time check of the Authorization bearer against SERVICE_BEARER_TOKEN.
    Returns True immediately when the token is unset (auth disabled)."""
    if not SERVICE_BEARER_TOKEN:
        return True
    header = req.headers.get("authorization", "")
    got = header[7:] if header[:7].lower() == "bearer " else ""
    return bool(got) and hmac.compare_digest(got, SERVICE_BEARER_TOKEN)


def _connect(principal: str | None = None, schema: str | None = None):
    return trino.dbapi.connect(
        **connect_kwargs(
            principal,
            schema or TRINO_SCHEMA,
            host=TRINO_HOST,
            port=TRINO_PORT,
            catalog=TRINO_CATALOG,
            http_scheme=os.environ.get("TRINO_HTTP_SCHEME", "http"),
            default_user=TRINO_USER,
        )
    )


def run_query(sql: str, principal: str | None = None, schema: str | None = None) -> dict:
    # Defence-in-depth: enforce read-only single-statement BEFORE touching Trino, so
    # the read tool can never mutate the lakehouse even if a caller sends write SQL.
    # (Trino's OPA plugin remains the authoritative row/column governance layer.)
    sql = guard_read(sql)
    eff_schema = schema or TRINO_SCHEMA
    conn = _connect(principal, eff_schema)
    cur = conn.cursor()
    cur.execute(sql)
    rows = cur.fetchall()
    cols = [d[0] for d in cur.description] if cur.description else []
    return {
        "engine": "trino",
        "catalog": TRINO_CATALOG,
        "schema": eff_schema,
        "columns": cols,
        "rows": [[str(v) for v in r] for r in rows],
        "row_count": len(rows),
    }


def run_execute(sql: str, principal: str, schema: str) -> dict:
    """Execute an already-guarded write DDL as `principal` (so Trino's OPA plugin
    governs the reads inside a CTAS AS THE CALLER). The session schema is set to the
    write target so unqualified refs resolve in the caller's own domain."""
    conn = _connect(principal, schema)
    cur = conn.cursor()
    cur.execute(sql)
    cur.fetchall()  # drain the result stream (CTAS returns a rowcount row)
    rc = getattr(cur, "rowcount", None)
    return {"ok": True, "rowsAffected": rc if isinstance(rc, int) and rc >= 0 else None}


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
    if not _bearer_ok(req):
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    body = await req.json()
    sql = body.get("sql", "")
    if not sql:
        return JSONResponse({"error": "missing sql"}, status_code=400)
    try:
        # Optional per-call identity so Trino's OPA plugin governs the right user,
        # and an optional session schema so the caller targets their own domain
        # (os-ui's catalog passes the caller's domain) instead of a fixed literal.
        # CONCURRENCY: the Trino DB-API call BLOCKS — run it on a worker thread so
        # one slow statement never serializes the whole async server (effective
        # concurrency of 1 was the scalability-audit finding).
        result = await asyncio.to_thread(
            run_query, sql, body.get("principal"), body.get("schema")
        )
        return JSONResponse(result)
    except ExecuteError as e:
        # Read-guard rejection (write/DDL/stacked/comment) — an honest 400, not a 500.
        return JSONResponse({"error": str(e)}, status_code=e.status)
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"error": str(e)}, status_code=500)


@mcp.custom_route("/execute", methods=["POST"])
async def http_execute(req: Request):
    """Governed WRITE path. Accepts a single allowlisted DDL statement and executes
    it as the caller's principal. Identity (principal/uid/domains/role) is supplied by
    os-ui SERVER-SIDE from the signed session — never by a browser — exactly as /query
    trusts `principal`. Two gates run BEFORE Trino: a strict statement allowlist and a
    target-schema/role check (see execute_guard). The data-confidentiality boundary is
    the Trino session user (principal): even a spoofed identity field cannot read past
    what that principal is entitled to, because the CTAS reads run under Trino->OPA."""
    if not _bearer_ok(req):
        return JSONResponse({"ok": False, "error": "unauthorized"}, status_code=401)
    body = await req.json()
    sql = body.get("sql", "")
    principal = body.get("principal")
    uid = body.get("uid")
    domains = body.get("domains") or []
    role = body.get("role")
    if not principal:
        return JSONResponse({"ok": False, "error": "missing principal"}, status_code=400)
    try:
        parsed = guard(sql, uid, domains, role)
    except ExecuteError as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=e.status)
    try:
        # CONCURRENCY: same worker-thread offload as /query — sync writes can run
        # for minutes (SYNC_STATEMENT_TIMEOUT_MS in os-ui); executed inline they
        # would block every other statement on the event loop. No server-side
        # timeout is enforced here — the CLIENT owns the statement budget.
        result = await asyncio.to_thread(run_execute, sql, principal, parsed.schema)
        return JSONResponse(result)
    except trino.exceptions.TrinoUserError as e:
        # A genuine SQL/permission error from Trino (incl. an OPA-denied read) — the
        # caller's mistake, surfaced honestly with the real message.
        return JSONResponse({"ok": False, "error": str(e)}, status_code=400)
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


if __name__ == "__main__":
    if not SERVICE_BEARER_TOKEN:
        print("[query] WARNING: SERVICE_BEARER_TOKEN unset — service-bearer auth "
              "DISABLED (fail-open; NetworkPolicy is the only boundary).")
    print(f"[query] Trino MCP (/mcp) + HTTP (/health,/query) on :{PORT} "
          f"(trino={TRINO_HOST}:{TRINO_PORT}, catalog={TRINO_CATALOG}, "
          f"schema={TRINO_SCHEMA}, bearerAuth={'on' if SERVICE_BEARER_TOKEN else 'off'})")
    mcp.run(transport="streamable-http")
