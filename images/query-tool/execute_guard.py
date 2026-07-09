# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
"""Governed-write guard for the query-tool `/execute` endpoint.

This is the SECURITY CORE of the write path and is deliberately kept in a pure,
stdlib-only module (no trino / mcp / starlette imports) so it is unit-testable
without the service dependencies and cannot be weakened by a runtime concern.

Two independent gates, both enforced here BEFORE any SQL reaches Trino:

  1. STATEMENT ALLOWLIST — only four DDL shapes are permitted:
       * CREATE SCHEMA IF NOT EXISTS iceberg.<schema>
       * CREATE OR REPLACE TABLE  iceberg.<schema>.<table> AS SELECT ...
       * CREATE TABLE IF NOT EXISTS iceberg.<schema>.<table> AS SELECT ...
       * DROP TABLE IF EXISTS      iceberg.<schema>.<table>
     Everything else (INSERT/UPDATE/DELETE/MERGE/GRANT/ALTER/CALL/SET/plain
     CREATE TABLE, multiple statements, SQL comments) is rejected with 400.
     Comments and extra statements are rejected outright so nothing can be
     smuggled past the shape match.

  2. TARGET-SCHEMA AUTHORIZATION — the write target must be one of the caller's
     own domains (role floor: builder) or their personal sandbox schema
     `personal_<uid>` (any authenticated user). Any other schema -> 403.

Why this lives in the query-tool and not (only) in the Trino->OPA plugin:
the plugin governs the *reads* embedded in a CTAS SELECT (row filters + column
masks), which is exactly what we want — the CTAS runs as the caller's principal,
so a build can only read what the builder may read. But the plugin's operation
authorization (`data.trino.allow`) is intentionally permissive (a blanket deny
breaks Trino's own metadata ops), and the write-target policy we need depends on
the caller's ROLE and UID, which are not present in the Trino session identity
(that is the domain principal only). So the authoritative write-target + role
gate is here; an additive OPA clause provides a second, coarser floor.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import List, Optional

CATALOG = "iceberg"
BUILDER_ROLES = {"builder", "admin"}  # role floor for domain-schema writes

# A bare, lowercase SQL identifier (no quoting allowed — keeps the surface tight).
_IDENT = r"[a-z_][a-z0-9_]*"

_RE_CREATE_SCHEMA = re.compile(
    rf"create\s+schema\s+if\s+not\s+exists\s+{CATALOG}\.({_IDENT})",
    re.IGNORECASE,
)
_RE_CTAS_REPLACE = re.compile(
    rf"create\s+or\s+replace\s+table\s+{CATALOG}\.({_IDENT})\.({_IDENT})\s+as\s+select\b.*",
    re.IGNORECASE | re.DOTALL,
)
_RE_CTAS_IFNE = re.compile(
    rf"create\s+table\s+if\s+not\s+exists\s+{CATALOG}\.({_IDENT})\.({_IDENT})\s+as\s+select\b.*",
    re.IGNORECASE | re.DOTALL,
)
_RE_DROP = re.compile(
    rf"drop\s+table\s+if\s+exists\s+{CATALOG}\.({_IDENT})\.({_IDENT})",
    re.IGNORECASE,
)


class ExecuteError(Exception):
    """A rejection with an HTTP status (400 = bad statement, 403 = not authorized)."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


@dataclass
class ParsedWrite:
    kind: str            # 'create_schema' | 'ctas' | 'drop_table'
    catalog: str         # always 'iceberg'
    schema: str          # target schema (the authorization subject)
    table: Optional[str] # None for create_schema


def sanitize_ident(value: str) -> str:
    """Normalize an identity/domain to the stable schema identifier os-ui mints —
    lowercase, collapse each run of non-[a-z0-9] to '_', strip leading/trailing '_',
    empty -> 'user'. Byte-identical to os-ui `sanitizeIdent` / `domainSchema` and the
    trino.rego `sanitize_ident`, so a hyphenated domain (`agentic-leader-q3-2026`)
    maps to its mart schema (`agentic_leader_q3_2026`) on EVERY side."""
    core = re.sub(r"[^a-z0-9]+", "_", (value or "").lower()).strip("_")
    return core or "user"


def personal_schema(uid: str) -> str:
    """The caller's private sandbox schema. Sanitized identically on both sides so
    a uid that isn't a bare identifier (e.g. an email) maps to a stable schema."""
    return "personal_" + sanitize_ident(uid)


def parse_statement(sql: str) -> ParsedWrite:
    """Validate + classify. Raises ExecuteError(400) for anything off the allowlist."""
    if not sql or not sql.strip():
        raise ExecuteError(400, "missing sql")
    s = sql.strip()

    # Reject comments outright — no comment-smuggling past the shape match.
    if "--" in s or "/*" in s or "*/" in s:
        raise ExecuteError(400, "SQL comments are not allowed on the write path")

    # Allow exactly ONE statement: strip a single optional trailing ';', then any
    # remaining ';' means multiple statements.
    if s.endswith(";"):
        s = s[:-1].rstrip()
    if ";" in s:
        raise ExecuteError(400, "multiple statements are not allowed")
    if not s:
        raise ExecuteError(400, "missing sql")

    m = _RE_CREATE_SCHEMA.fullmatch(s)
    if m:
        return ParsedWrite("create_schema", CATALOG, m.group(1), None)

    m = _RE_CTAS_REPLACE.fullmatch(s) or _RE_CTAS_IFNE.fullmatch(s)
    if m:
        return ParsedWrite("ctas", CATALOG, m.group(1), m.group(2))

    m = _RE_DROP.fullmatch(s)
    if m:
        return ParsedWrite("drop_table", CATALOG, m.group(1), m.group(2))

    raise ExecuteError(
        400,
        "statement not allowed: only CREATE SCHEMA IF NOT EXISTS, "
        "CREATE OR REPLACE TABLE ... AS SELECT, CREATE TABLE IF NOT EXISTS ... AS "
        "SELECT, and DROP TABLE IF EXISTS against iceberg.<schema>.<table> are permitted",
    )


def authorize_target(parsed: ParsedWrite, uid: str, domains: List[str], role: str) -> None:
    """Enforce the write-target floor. Raises ExecuteError(403) on a cross-schema
    write or an under-privileged domain write."""
    target = parsed.schema
    # os-ui mints a domain's mart SCHEMA as sanitizeIdent(domain) (store-fqn.domainSchema),
    # so a hyphenated domain `agentic-leader-q3-2026` writes to schema
    # `agentic_leader_q3_2026`. The caller's `domains` carry the RAW domain ids, so match
    # on the SANITIZED form (byte-identical to the minting rule) — otherwise a builder
    # could never write its own domain mart when the domain id isn't a bare identifier.
    entitled_schemas = {sanitize_ident(d) for d in (domains or [])}
    if target in entitled_schemas:
        # Domain schema: role floor is builder (admin >= builder).
        if role not in BUILDER_ROLES:
            raise ExecuteError(
                403,
                f"role '{role}' may not write to domain schema '{target}' "
                "(builder role required)",
            )
        return
    if target == personal_schema(uid):
        # Personal sandbox: any authenticated user.
        return
    raise ExecuteError(
        403,
        f"write target schema '{target}' is neither one of your domains "
        f"({', '.join(domains or []) or 'none'}) nor your personal schema",
    )


def guard(sql: str, uid: str, domains: List[str], role: str) -> ParsedWrite:
    """Full gate: allowlist + target authorization. Returns the parsed write on OK."""
    if not uid or not role:
        raise ExecuteError(400, "missing caller identity (uid/role)")
    parsed = parse_statement(sql)
    authorize_target(parsed, uid, domains, role)
    return parsed


def connect_kwargs(
    principal: Optional[str],
    schema: Optional[str],
    *,
    host: str,
    port: int,
    catalog: str,
    http_scheme: str,
    default_user: str,
):
    """Build the Trino connection kwargs. Factored out (and unit-tested) so the key
    invariant is provable without a live Trino: the session `user` is the CALLER's
    principal — never dropped or replaced by the tool's service identity — so the
    reads inside a CTAS SELECT are governed by the Trino->OPA plugin AS THE CALLER
    (a build can only read what the builder may read)."""
    return {
        "host": host,
        "port": port,
        "user": principal or default_user,
        "catalog": catalog,
        "schema": schema,
        "http_scheme": http_scheme,
    }
