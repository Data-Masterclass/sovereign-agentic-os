#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
"""data-runner — the real INGEST service of the Sovereign Agentic OS.

Turns an uploaded file (already streamed to MinIO by os-ui under
`s3://<bucket>/uploads/<uid>/<file>`) into a PHYSICAL Iceberg Bronze table on the
Polaris REST catalog, so the Data-tab "Upload" stops being an in-memory placebo.

Path (single-purpose, no orchestration):
  MinIO object (boto3 GET, no httpfs -> works under default-deny egress)
    -> DuckDB reads + infers the schema (CSV/Parquet/JSON)
    -> PyIceberg writes `lakehouse.personal_<uid>.bronze_<slug>` via Polaris REST.

Governance / isolation (M1 = personal lane ONLY):
  * The target namespace is `personal_<uid>` DERIVED FROM the caller's `principal`
    (the trusted os-ui backend supplies it, session-bound, never the browser) — the
    request body can NOT pick an arbitrary domain schema. A caller can only land data
    in their OWN personal schema.
  * The object being read MUST live under the caller's own `uploads/<uid>/` prefix
    (cross-user object-read guard).
  * Per-user READ isolation of `personal_<uid>.*` is enforced downstream by the
    Trino->OPA row rule (keyed on principal) on the governed read path — the same
    boundary every other reader crosses. The runner is the writer, not a read door.

Polaris credential model: MinIO has no STS, so Polaris credential-subscoping is OFF
(SKIP_CREDENTIAL_SUBSCOPING_INDIRECTION) — exactly like Trino, the client's own static
object-storage creds write the Parquet data files, while namespace/table registration
goes through Polaris. We therefore reuse the SAME Polaris OAuth client Trino writes
Iceberg with (trino-catalog-credentials) and the SAME object-storage creds — no new
broad credentials are invented.

Plain HTTP: POST /ingest + GET /health.
"""
import io
import json
import os
import re
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import boto3
import duckdb
from botocore.config import Config as BotoConfig
from pyiceberg.catalog import load_catalog

PORT = int(os.environ.get("PORT", "8000"))

# Polaris REST catalog (Iceberg). Same endpoint/warehouse Trino uses.
POLARIS_URI = os.environ.get("POLARIS_URI", "http://polaris:8181/api/catalog")
POLARIS_WAREHOUSE = os.environ.get("POLARIS_WAREHOUSE", "lakehouse")
POLARIS_OAUTH_SCOPE = os.environ.get("POLARIS_OAUTH_SCOPE", "PRINCIPAL_ROLE:ALL")
# "<clientId>:<clientSecret>" — the same Polaris OAuth client Trino writes with.
POLARIS_OAUTH_CREDENTIAL = os.environ.get("POLARIS_OAUTH_CREDENTIAL", "")

# Object storage (MinIO locally / STACKIT Object Storage).
S3_ENDPOINT = os.environ.get("S3_ENDPOINT", "http://minio:9000")
S3_REGION = os.environ.get("S3_REGION", "us-east-1")
S3_PATH_STYLE = os.environ.get("S3_PATH_STYLE", "true")
UPLOADS_BUCKET = os.environ.get("UPLOADS_BUCKET", "lakehouse")
AWS_ACCESS_KEY_ID = os.environ.get("AWS_ACCESS_KEY_ID", "")
AWS_SECRET_ACCESS_KEY = os.environ.get("AWS_SECRET_ACCESS_KEY", "")

_SLUG_RE = re.compile(r"[^a-z0-9]+")


def slug(value: str) -> str:
    """Lowercase, identifier-safe slug (also the guard against SQL/identifier
    injection into namespace/table names)."""
    s = _SLUG_RE.sub("_", (value or "").strip().lower()).strip("_")
    return s


def _s3_client():
    return boto3.client(
        "s3",
        endpoint_url=S3_ENDPOINT,
        aws_access_key_id=AWS_ACCESS_KEY_ID,
        aws_secret_access_key=AWS_SECRET_ACCESS_KEY,
        region_name=S3_REGION,
        config=BotoConfig(s3={"addressing_style": "path"}),
    )


def _catalog():
    return load_catalog(
        "lakehouse",
        **{
            "type": "rest",
            "uri": POLARIS_URI,
            "warehouse": POLARIS_WAREHOUSE,
            "credential": POLARIS_OAUTH_CREDENTIAL,
            "scope": POLARIS_OAUTH_SCOPE,
            # Static S3 FileIO creds for the client-side data-file write (Polaris
            # vends none — no STS on MinIO). Mirrors Trino's s3.* catalog props.
            "s3.endpoint": S3_ENDPOINT,
            "s3.access-key-id": AWS_ACCESS_KEY_ID,
            "s3.secret-access-key": AWS_SECRET_ACCESS_KEY,
            "s3.region": S3_REGION,
            "s3.path-style-access": S3_PATH_STYLE,
        },
    )


def _read_to_arrow(local_path: str, object_key: str):
    """Read the downloaded file with DuckDB (schema inference) -> Arrow table."""
    lower = object_key.lower()
    if lower.endswith(".parquet"):
        reader = "read_parquet"
    elif lower.endswith(".json") or lower.endswith(".ndjson"):
        reader = "read_json_auto"
    else:  # default: CSV (covers .csv / .tsv / .txt)
        reader = "read_csv_auto"
    con = duckdb.connect()
    try:
        con.execute("SET temp_directory='/tmp'")
        # local_path is a runner-controlled temp path (never caller input) — safe to inline.
        return con.execute(
            f"SELECT * FROM {reader}('{local_path}')"
        ).fetch_arrow_table()
    finally:
        con.close()


def ingest(body: dict) -> dict:
    principal = (body.get("principal") or "").strip()
    dataset = (body.get("dataset") or "").strip()
    object_key = (body.get("objectKey") or "").strip()
    if not principal:
        raise ValueError("missing principal")
    if not dataset:
        raise ValueError("missing dataset")
    if not object_key:
        raise ValueError("missing objectKey")

    uid = slug(principal)
    ds_slug = slug(dataset)
    if not uid:
        raise ValueError("principal did not resolve to a valid uid")
    if not ds_slug:
        raise ValueError("dataset did not resolve to a valid name")

    # M1 personal lane ONLY: target schema is derived from the caller, not the body.
    namespace = f"personal_{uid}"
    requested = slug(body.get("schema") or namespace)
    if requested != namespace:
        raise PermissionError(
            f"schema '{body.get('schema')}' not allowed; personal lane only "
            f"(target is {namespace})"
        )

    # Cross-user object-read guard: the object must be in the caller's own prefix.
    expected_prefix = f"uploads/{uid}/"
    if not object_key.startswith(expected_prefix):
        raise PermissionError(
            f"objectKey must be under {expected_prefix} (got '{object_key}')"
        )

    table_name = f"bronze_{ds_slug}"
    fqn_trino = f"iceberg.{namespace}.{table_name}"

    # 1) Pull the uploaded object from MinIO to a temp file (boto3, no httpfs).
    suffix = os.path.splitext(object_key)[1] or ".csv"
    s3 = _s3_client()
    obj = s3.get_object(Bucket=UPLOADS_BUCKET, Key=object_key)
    data = obj["Body"].read()
    with tempfile.NamedTemporaryFile(
        dir="/tmp", suffix=suffix, delete=True
    ) as tmp:
        tmp.write(data)
        tmp.flush()
        arrow = _read_to_arrow(tmp.name, object_key)

    # 2) Write the Iceberg Bronze table via Polaris REST.
    catalog = _catalog()
    catalog.create_namespace_if_not_exists((namespace,))
    # Fresh re-ingest semantics: replace any prior version of this bronze table.
    if catalog.table_exists((namespace, table_name)):
        catalog.drop_table((namespace, table_name))
    tbl = catalog.create_table((namespace, table_name), schema=arrow.schema)
    tbl.append(arrow)

    columns = [{"name": f.name, "type": str(f.type)} for f in arrow.schema]
    return {
        "ok": True,
        "table": fqn_trino,
        "rowCount": arrow.num_rows,
        "columns": columns,
    }


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, payload: dict):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.rstrip("/") == "/health":
            self._send(200, {"status": "ok", "engine": "duckdb+pyiceberg",
                             "warehouse": POLARIS_WAREHOUSE})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path.rstrip("/") != "/ingest":
            self._send(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(length) or b"{}")
        except Exception as e:  # noqa: BLE001
            self._send(400, {"ok": False, "error": f"bad request: {e}"})
            return
        try:
            self._send(200, ingest(body))
        except (ValueError, KeyError) as e:
            self._send(400, {"ok": False, "error": str(e)})
        except PermissionError as e:
            self._send(403, {"ok": False, "error": str(e)})
        except Exception as e:  # noqa: BLE001 — surface real errors honestly
            self._send(500, {"ok": False, "error": str(e)})

    def log_message(self, fmt, *args):  # quieter, structured-enough logs
        print(f"[data-runner] {self.address_string()} {fmt % args}")


def main():
    print(f"[data-runner] /ingest + /health on :{PORT} "
          f"(polaris={POLARIS_URI}, warehouse={POLARIS_WAREHOUSE}, "
          f"s3={S3_ENDPOINT}, uploadsBucket={UPLOADS_BUCKET})")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
