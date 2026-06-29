#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
"""Sandbox DuckDB — the personal/sandbox lane engine.

Ephemeral DuckDB scoped to the user's PRIVATE PREFIX only (their uploads + a
Trino-authorized, already row/column-masked extract). It has **NO** Polaris /
Iceberg-catalog credentials, so by construction it cannot reach governed marts —
that is the invariant: DuckDB is never a second, ungoverned door to shared data.
Reads CSV/Parquet from object storage under the sandbox prefix via DuckDB httpfs.
"""
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import duckdb

PORT = int(os.environ.get("PORT", "8000"))
S3_ENDPOINT = os.environ.get("S3_ENDPOINT", "http://minio:9000")
S3_REGION = os.environ.get("S3_REGION", "us-east-1")
AWS_KEY = os.environ.get("AWS_ACCESS_KEY_ID", "")
AWS_SECRET = os.environ.get("AWS_SECRET_ACCESS_KEY", "")
SANDBOX_BUCKET = os.environ.get("SANDBOX_BUCKET", "sandbox")
# NOTE: there is intentionally NO Polaris / Iceberg-catalog config here. The
# sandbox engine can only ever see the private sandbox prefix on object storage.


def _con():
    con = duckdb.connect()
    try:
        con.execute("INSTALL httpfs; LOAD httpfs;")
    except Exception:  # noqa: BLE001 — httpfs may be bundled; ignore if present
        pass
    host = S3_ENDPOINT.split("://", 1)[-1]
    con.execute(f"SET s3_endpoint='{host}';")
    con.execute(f"SET s3_region='{S3_REGION}';")
    con.execute(f"SET s3_use_ssl={'true' if S3_ENDPOINT.startswith('https') else 'false'};")
    con.execute("SET s3_url_style='path';")
    if AWS_KEY:
        con.execute(f"SET s3_access_key_id='{AWS_KEY}';")
        con.execute(f"SET s3_secret_access_key='{AWS_SECRET}';")
    return con


def run_query(sql: str) -> dict:
    con = _con()
    res = con.execute(sql)
    cols = [d[0] for d in res.description] if res.description else []
    rows = [[str(v) for v in r] for r in res.fetchall()]
    return {"engine": "duckdb", "scope": f"s3://{SANDBOX_BUCKET}/",
            "columns": cols, "rows": rows, "row_count": len(rows)}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, obj: dict):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        if self.path == "/health":
            self._send(200, {"status": "ok", "engine": "duckdb",
                             "scope": f"s3://{SANDBOX_BUCKET}/"})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):  # noqa: N802
        if self.path != "/query":
            self._send(404, {"error": "not found"})
            return
        n = int(self.headers.get("content-length", "0"))
        body = json.loads(self.rfile.read(n) or b"{}")
        sql = body.get("sql", "")
        if not sql:
            self._send(400, {"error": "missing sql"})
            return
        try:
            self._send(200, run_query(sql))
        except Exception as e:  # noqa: BLE001
            self._send(500, {"error": str(e)})

    def log_message(self, *_a):  # quiet
        pass


if __name__ == "__main__":
    print(f"[sandbox-duckdb] :{PORT} scope=s3://{SANDBOX_BUCKET}/ "
          f"(no Polaris/catalog — sandbox prefix only)")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
