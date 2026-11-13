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

# ---- READ BUDGET (B4-review E-1). `query_data` used to be unbounded end to end: no
# `request_timeout`, no `query_max_run_time`, and a `fetchall()` that materialised the whole
# result set into this process before anything measured it. os-ui's 8 s `AbortSignal`
# (core/infra/governed.ts) only ends os-ui's WAIT — the query kept running on the cluster and
# this process kept buffering. Two ceilings now apply to every read:
#   * QUERY_MAX_RUN_TIME — a Trino session property, so TRINO abandons the statement;
#   * QUERY_MAX_ROWS     — this process fetches at most max+1 rows and reports `truncated`.
# `request_timeout` is derived from the run-time ceiling so the client gives up no earlier than
# Trino does (a shorter client timeout would orphan the query, which is the bug).
QUERY_MAX_RUN_TIME = os.environ.get("QUERY_MAX_RUN_TIME", "60s")
QUERY_MAX_ROWS = int(os.environ.get("QUERY_MAX_ROWS", "10000") or 10000)
# WRITES are deliberately NOT bounded by default: a full-refresh sync or a promote CTAS can
# legitimately run for many minutes, and a ceiling guessed here would abort real work. Set
# EXECUTE_MAX_RUN_TIME (e.g. "900s") to impose one; empty means Trino's own cluster limits are
# the only bound, which is what the code does today and what the comment on /execute now says.
EXECUTE_MAX_RUN_TIME = os.environ.get("EXECUTE_MAX_RUN_TIME", "")


def _seconds(duration: str, fallback: int = 60) -> int:
    """`"60s"` / `"5m"` / `"90"` -> seconds. Unparseable -> `fallback`, never an exception:
    a malformed env var must not take the service down, and the ceiling still applies."""
    text = (duration or "").strip().lower()
    if not text:
        return fallback
    try:
        if text.endswith("ms"):
            return max(1, int(float(text[:-2]) / 1000))
        if text.endswith("s"):
            return max(1, int(float(text[:-1])))
        if text.endswith("m"):
            return max(1, int(float(text[:-1]) * 60))
        if text.endswith("h"):
            return max(1, int(float(text[:-1]) * 3600))
        return max(1, int(float(text)))
    except ValueError:
        return fallback

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


def _connect(
    principal: str | None = None,
    schema: str | None = None,
    *,
    max_run_time: str | None = QUERY_MAX_RUN_TIME,
):
    """Connect as `principal`, bounded by `max_run_time` (a Trino session property) and a
    matching HTTP `request_timeout`. Pass `max_run_time=""`/`None` for an unbounded statement."""
    return trino.dbapi.connect(
        **connect_kwargs(
            principal,
            schema or TRINO_SCHEMA,
            host=TRINO_HOST,
            port=TRINO_PORT,
            catalog=TRINO_CATALOG,
            http_scheme=os.environ.get("TRINO_HTTP_SCHEME", "http"),
            default_user=TRINO_USER,
            # +5 s of slack: the client must not give up BEFORE Trino kills the query, or the
            # query is orphaned on the cluster — the defect this fixes.
            request_timeout=(_seconds(max_run_time) + 5) if max_run_time else None,
            max_run_time=max_run_time or None,
        )
    )


def run_query(sql: str, principal: str | None = None, schema: str | None = None) -> dict:
    # Defence-in-depth: enforce read-only single-statement BEFORE touching Trino, so
    # the read tool can never mutate the lakehouse even if a caller sends write SQL.
    # (Trino's OPA plugin remains the authoritative row/column governance layer.)
    sql = guard_read(sql)
    eff_schema = schema or TRINO_SCHEMA
    try:
        conn = _connect(principal, eff_schema)
        cur = conn.cursor()
        cur.execute(sql)
        # At most max+1 rows leave Trino's stream: the extra row is how `truncated` is MEASURED
        # rather than guessed, and `fetchall()` on an unbounded `select *` is what used to put
        # the whole table in this process's heap.
        fetched = cur.fetchmany(QUERY_MAX_ROWS + 1)
        truncated = len(fetched) > QUERY_MAX_ROWS
        rows = fetched[:QUERY_MAX_ROWS]
        cols = [d[0] for d in cur.description] if cur.description else []
    except trino.exceptions.TrinoConnectionError:
        # Trino unreachable (DNS/connection refused) - the base deployment has no
        # lakehouse at all, not a transient outage.
        return {"error": "no_catalog_configured",
                "message": "No lakehouse is configured in this deployment "
                            "(Trino is unreachable) - the data/lakehouse extension "
                            "is not enabled."}
    result = {
        "engine": "trino",
        "catalog": TRINO_CATALOG,
        "schema": eff_schema,
        "columns": cols,
        "rows": [[str(v) for v in r] for r in rows],
        "row_count": len(rows),
    }
    if truncated:
        # Say it, every time, in the payload a caller already parses. A silently clipped result
        # set is the one answer worse than an error.
        result["truncated"] = True
        result["row_limit"] = QUERY_MAX_ROWS
        result["message"] = (
            f"Result truncated at {QUERY_MAX_ROWS} rows (QUERY_MAX_ROWS). "
            "Add a LIMIT, aggregate, or narrow the filter — the rows above are the first "
            f"{QUERY_MAX_ROWS}, not a sample."
        )
    return result


def run_execute(sql: str, principal: str, schema: str) -> dict:
    """Execute an already-guarded write DDL as `principal` (so Trino's OPA plugin
    governs the reads inside a CTAS AS THE CALLER). The session schema is set to the
    write target so unqualified refs resolve in the caller's own domain.

    Bounded only when EXECUTE_MAX_RUN_TIME is set — see its comment above."""
    conn = _connect(principal, schema, max_run_time=EXECUTE_MAX_RUN_TIME or None)
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
        # would block every other statement on the event loop.
        #
        # STATEMENT BUDGET, truthfully (B4-review E-1): unless EXECUTE_MAX_RUN_TIME is set,
        # NOTHING bounds a write statement here. The client's abort (os-ui's `AbortSignal`)
        # ends os-ui's WAIT, not the query — Trino keeps running it until the cluster's own
        # limits end it. That is a deliberate default for writes, which legitimately run for
        # minutes; it is not "the client owns the budget", which this comment used to claim.
        # Reads are bounded by QUERY_MAX_RUN_TIME + QUERY_MAX_ROWS.
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
