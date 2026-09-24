#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
"""data-runner — the real INGEST service of the Sovereign Agentic OS.

Turns an uploaded file (already streamed to MinIO by os-ui under
`s3://<bucket>/uploads/<uid>/<file>`) into a PHYSICAL Iceberg Bronze table on the
Polaris REST catalog, so the Data-tab "Upload" stops being an in-memory placebo.

Path (single-purpose, no orchestration):
  MinIO object (boto3 GET, no httpfs -> works under default-deny egress)
    -> PyArrow reads the file (CSV as RAW strings — no type coercion; Parquet/JSON
       keep their native types)
    -> PyIceberg writes `lakehouse.personal_<uid>.bronze_<slug>` via Polaris REST.

/ingest-rows accepts a JSON body with inline rows (list of dicts) instead of an
S3 object key. Designed for Salesforce API-batch sync: os-ui pulls rows from the
Salesforce REST API (which Trino cannot reach) and streams them here page-by-page.
Each batch is written to a temp NDJSON file so the same PyArrow read_json path
infers the schema — identical to an NDJSON file upload. Callers must page their
payloads; a single batch is capped at 10 000 rows.

Governance / isolation (M1 = personal lane ONLY):
  * The target namespace is `personal_<uid>` DERIVED FROM the caller's `principal`
    (the trusted os-ui backend supplies it, session-bound, never the browser) — the
    request body can NOT pick an arbitrary domain schema. A caller can only land data
    in their OWN personal schema.
  * The object being read MUST live under the caller's own `uploads/<uid>/` prefix
    (cross-user object-read guard, /ingest only).
  * Per-user READ isolation of `personal_<uid>.*` is enforced downstream by the
    Trino->OPA row rule (keyed on principal) on the governed read path — the same
    boundary every other reader crosses. The runner is the writer, not a read door.

Polaris credential model: MinIO has no STS, so Polaris credential-subscoping is OFF
(SKIP_CREDENTIAL_SUBSCOPING_INDIRECTION) — exactly like Trino, the client's own static
object-storage creds write the Parquet data files, while namespace/table registration
goes through Polaris. We therefore reuse the SAME Polaris OAuth client Trino writes
Iceberg with (trino-catalog-credentials) and the SAME object-storage creds — no new
broad credentials are invented.

Plain HTTP: POST /ingest + POST /ingest-rows + GET /health.
"""
import hmac
import io
import csv as csvmod
import json
import os
import re
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import boto3
import pyarrow as pa
from botocore.config import Config as BotoConfig
from pyarrow import csv as pacsv
from pyarrow import json as pajson
from pyarrow import parquet as papq
from pyiceberg.catalog import load_catalog

PORT = int(os.environ.get("PORT", "8000"))

# Service-to-service bearer (defense-in-depth). This process trusts the caller's
# `principal` (session-bound, supplied by os-ui) and is only meant to be called by
# os-ui; the NetworkPolicies are the primary boundary, but network reach alone must
# not equal identity. When SERVICE_BEARER_TOKEN is set, /ingest + /ingest-rows require
# a matching `Authorization: Bearer <token>` (constant-time). When UNSET, the check is
# skipped (fail-open by design — see startup warning). /health is always open.
SERVICE_BEARER_TOKEN = os.environ.get("SERVICE_BEARER_TOKEN", "")


def bearer_ok(auth_header: str) -> bool:
    """Constant-time check of the Authorization bearer against SERVICE_BEARER_TOKEN.
    Returns True immediately when the token is unset (auth disabled)."""
    if not SERVICE_BEARER_TOKEN:
        return True
    got = auth_header[7:] if auth_header[:7].lower() == "bearer " else ""
    return bool(got) and hmac.compare_digest(got, SERVICE_BEARER_TOKEN)


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
    cat = load_catalog(
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
    # Polaris grants the catalog principal CREATE_TABLE_STAGED but NOT the
    # *_WITH_WRITE_DELEGATION variant (matching Trino's vended-credentials-enabled=false).
    # PyIceberg sends `X-Iceberg-Access-Delegation: vended-credentials` by DEFAULT, which
    # makes create_table request WRITE_DELEGATION → ForbiddenException(CREATE_TABLE_DIRECT_
    # WITH_WRITE_DELEGATION). We write data files with our OWN static S3 creds above, so we
    # never need vended credentials — drop the header so the op is the granted STAGED create.
    # (Identical to the northpeak-marts-init fix.)
    for hk in list(cat._session.headers.keys()):
        if hk.lower() == "x-iceberg-access-delegation":
            cat._session.headers.pop(hk)
    return cat


def _csv_columns(local_path: str, delimiter: str) -> list:
    """The header row's column names — read directly so we can force every column to
    string BEFORE PyArrow infers types. utf-8-sig strips a leading BOM."""
    with open(local_path, newline="", encoding="utf-8-sig") as fh:
        return next(csvmod.reader(fh, delimiter=delimiter), [])


def _read_to_arrow(local_path: str, object_key: str):
    """Read the downloaded file into an Arrow table with PyArrow (NO DuckDB).

    BRONZE IS THE RAW LANDING — no automatic type coercion. A delimited text file
    (CSV/TSV/TXT) carries no real types, so we read every column as string: the
    values "yes"/"no" must stay "yes"/"no" and never become a boolean, "40" stays
    "40", "2024-01-01" stays text. Guessing types here silently rewrites the user's
    data (yes/no → true/false was the reported bug). Type conversion is an explicit,
    opt-in step in Silver, never in Bronze. We force strings by naming every column
    string in ConvertOptions (learned from the header row).

    Parquet is a typed columnar format (its stored types ARE the source of truth)
    and JSON carries native type tokens, so those keep their embedded types — only
    untyped delimited text is forced to string.
    """
    lower = object_key.lower()
    if lower.endswith(".parquet"):
        return papq.read_table(local_path)
    if lower.endswith(".json") or lower.endswith(".ndjson"):
        return pajson.read_json(local_path)
    # default: CSV (covers .csv / .tsv / .txt) — raw landing, every column string.
    delimiter = "\t" if lower.endswith(".tsv") else ","
    names = _csv_columns(local_path, delimiter)
    convert = pacsv.ConvertOptions(column_types={n: pa.string() for n in names})
    parse = pacsv.ParseOptions(delimiter=delimiter)
    return pacsv.read_csv(local_path, parse_options=parse, convert_options=convert)


def ingest(body: dict) -> dict:
    principal = (body.get("principal") or "").strip()
    dataset = (body.get("dataset") or "").strip()
    object_key = (body.get("objectKey") or "").strip()
    # 'replace' (default, today's behaviour): drop + recreate the bronze table.
    # 'append': add the new rows to the existing table (incremental file drops) —
    # falls back to a plain create when the table doesn't exist yet.
    mode = (body.get("mode") or "replace").strip().lower()
    if not principal:
        raise ValueError("missing principal")
    if not dataset:
        raise ValueError("missing dataset")
    if not object_key:
        raise ValueError("missing objectKey")
    if mode not in ("replace", "append"):
        raise ValueError("mode must be 'replace' or 'append'")

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
    exists = catalog.table_exists((namespace, table_name))
    if mode == "append" and exists:
        # Incremental drop: keep the table, append the new rows (PyIceberg validates
        # the Arrow schema against the table schema and errors honestly on drift).
        tbl = catalog.load_table((namespace, table_name))
    else:
        # Fresh (re-)ingest semantics: replace any prior version of this bronze table.
        if exists:
            catalog.drop_table((namespace, table_name))
        tbl = catalog.create_table((namespace, table_name), schema=arrow.schema)
    tbl.append(arrow)

    columns = [{"name": f.name, "type": str(f.type)} for f in arrow.schema]
    return {
        "ok": True,
        "table": fqn_trino,
        "rowCount": arrow.num_rows,
        "columns": columns,
        "mode": mode,
    }


_INGEST_ROWS_CAP = 10_000  # callers must page; this endpoint must never buffer huge payloads


def ingest_rows(body: dict) -> dict:
    """Ingest an inline list of row dicts into a personal-lane Bronze table.

    Accepts: { principal, dataset, rows, mode? }
    Writes rows to a temp NDJSON file and reads it back through the same
    _read_to_arrow / read_json_auto path as /ingest — schema inference is identical.
    """
    principal = (body.get("principal") or "").strip()
    dataset = (body.get("dataset") or "").strip()
    rows = body.get("rows")
    mode = (body.get("mode") or "replace").strip().lower()

    if not principal:
        raise ValueError("missing principal")
    if not dataset:
        raise ValueError("missing dataset")
    if not isinstance(rows, list) or len(rows) == 0:
        raise ValueError("rows must be a non-empty list of dicts")
    if len(rows) > _INGEST_ROWS_CAP:
        raise ValueError(
            f"batch exceeds {_INGEST_ROWS_CAP}-row cap ({len(rows)} rows); "
            "stream page-by-page"
        )
    if mode not in ("replace", "append"):
        raise ValueError("mode must be 'replace' or 'append'")

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

    table_name = f"bronze_{ds_slug}"
    fqn_trino = f"iceberg.{namespace}.{table_name}"

    # Materialise the row batch as NDJSON so _read_to_arrow / PyArrow read_json infers
    # the schema exactly like a JSON file upload does (same path, same types).
    with tempfile.NamedTemporaryFile(
        dir="/tmp", suffix=".ndjson", delete=True, mode="w", encoding="utf-8"
    ) as tmp:
        for row in rows:
            tmp.write(json.dumps(row) + "\n")
        tmp.flush()
        arrow = _read_to_arrow(tmp.name, f"{ds_slug}.ndjson")

    # Write the Iceberg Bronze table via Polaris REST (same logic as /ingest).
    catalog = _catalog()
    catalog.create_namespace_if_not_exists((namespace,))
    exists = catalog.table_exists((namespace, table_name))
    if mode == "append" and exists:
        # Keep the table; PyIceberg validates the Arrow schema against the table schema
        # and errors honestly on drift — surfaces as a 500 with the real message.
        tbl = catalog.load_table((namespace, table_name))
    else:
        if exists:
            catalog.drop_table((namespace, table_name))
        tbl = catalog.create_table((namespace, table_name), schema=arrow.schema)
    tbl.append(arrow)

    columns = [{"name": f.name, "type": str(f.type)} for f in arrow.schema]
    return {
        "ok": True,
        "table": fqn_trino,
        "rowCount": arrow.num_rows,
        "columns": columns,
        "mode": mode,
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
            self._send(200, {"status": "ok", "engine": "pyarrow+pyiceberg",
                             "warehouse": POLARIS_WAREHOUSE})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        path = self.path.rstrip("/")
        if path not in ("/ingest", "/ingest-rows"):
            self._send(404, {"error": "not found"})
            return
        if not bearer_ok(self.headers.get("Authorization", "")):
            self._send(401, {"ok": False, "error": "unauthorized"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(length) or b"{}")
        except Exception as e:  # noqa: BLE001
            self._send(400, {"ok": False, "error": f"bad request: {e}"})
            return
        try:
            handler_fn = ingest if path == "/ingest" else ingest_rows
            self._send(200, handler_fn(body))
        except (ValueError, KeyError) as e:
            self._send(400, {"ok": False, "error": str(e)})
        except PermissionError as e:
            self._send(403, {"ok": False, "error": str(e)})
        except Exception as e:  # noqa: BLE001 — surface real errors honestly
            self._send(500, {"ok": False, "error": str(e)})

    def log_message(self, fmt, *args):  # quieter, structured-enough logs
        print(f"[data-runner] {self.address_string()} {fmt % args}")


def main():
    if not SERVICE_BEARER_TOKEN:
        print("[data-runner] WARNING: SERVICE_BEARER_TOKEN unset — service-bearer auth "
              "DISABLED (fail-open; NetworkPolicy is the only boundary).")
    print(f"[data-runner] /ingest + /ingest-rows + /health on :{PORT} "
          f"(polaris={POLARIS_URI}, warehouse={POLARIS_WAREHOUSE}, "
          f"s3={S3_ENDPOINT}, uploadsBucket={UPLOADS_BUCKET}, "
          f"bearerAuth={'on' if SERVICE_BEARER_TOKEN else 'off'})")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
