# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
"""Shared Iceberg catalog config for the query tool + bootstrap.

Functional catalog = pyiceberg SQL catalog with metadata in CloudNativePG and
data on object storage (SeaweedFS) using static S3 creds — no credential vending.
Polaris is deployed as the production Iceberg REST catalog; locally its S3
credential vending needs AWS STS (absent in SeaweedFS), so the query path uses
this CNPG-backed catalog instead. Same Iceberg tables, same object storage.
"""
import os

BASE_LOCATION = os.environ.get("BASE_LOCATION", "s3://lakehouse/wh")
S3_ENDPOINT = os.environ.get("S3_ENDPOINT", "http://seaweedfs:8333")
S3_REGION = os.environ.get("S3_REGION", "us-east-1")
AWS_KEY = os.environ.get("AWS_ACCESS_KEY_ID", "")
AWS_SECRET = os.environ.get("AWS_SECRET_ACCESS_KEY", "")
NAMESPACE = os.environ.get("NAMESPACE", "analytics")

# Catalog metadata DB (CloudNativePG `polaris` database).
PGHOST = os.environ.get("PGHOST", "pg-rw")
PGDATABASE = os.environ.get("PGDATABASE", "polaris")
PGUSER = os.environ.get("PGUSER", os.environ.get("username", "polaris"))
PGPASSWORD = os.environ.get("PGPASSWORD", os.environ.get("password", ""))
CATALOG_DB_URI = os.environ.get(
    "CATALOG_DB_URI",
    f"postgresql+psycopg2://{PGUSER}:{PGPASSWORD}@{PGHOST}:5432/{PGDATABASE}",
)


def catalog():
    from pyiceberg.catalog.sql import SqlCatalog
    return SqlCatalog(
        "lakehouse",
        **{
            "uri": CATALOG_DB_URI,
            "warehouse": BASE_LOCATION,
            "s3.endpoint": S3_ENDPOINT,
            "s3.access-key-id": AWS_KEY,
            "s3.secret-access-key": AWS_SECRET,
            "s3.path-style-access": "true",
            "s3.region": S3_REGION,
        },
    )
