#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
"""Bootstrap the lakehouse: create a namespace + a sample Iceberg table with
data on object storage (SeaweedFS), catalog metadata in CloudNativePG. Idempotent."""
from datetime import date

import pyarrow as pa
from pyiceberg.schema import Schema
from pyiceberg.types import DateType, DoubleType, LongType, NestedField, StringType

import common as C

TABLE = "orders"


def main():
    cat = C.catalog()
    cat.create_namespace_if_not_exists(C.NAMESPACE)
    print(f"[bootstrap] namespace {C.NAMESPACE} ready")

    schema = Schema(
        NestedField(1, "order_id", LongType(), required=False),
        NestedField(2, "customer", StringType(), required=False),
        NestedField(3, "amount", DoubleType(), required=False),
        NestedField(4, "order_date", DateType(), required=False),
    )
    ident = f"{C.NAMESPACE}.{TABLE}"
    if cat.table_exists(ident):
        tbl = cat.load_table(ident)
        if len(tbl.scan().to_arrow()) > 0:
            print(f"[bootstrap] table {ident} already has data; done")
            return
    else:
        tbl = cat.create_table(ident, schema=schema)
        print(f"[bootstrap] created Iceberg table {ident} on {C.BASE_LOCATION}")

    data = pa.table({
        "order_id": pa.array([1, 2, 3, 4, 5], pa.int64()),
        "customer": ["acme", "acme", "globex", "initech", "globex"],
        "amount": [100.0, 50.0, 200.0, 75.5, 125.0],
        "order_date": [date(2026, 1, 1), date(2026, 1, 1), date(2026, 1, 2),
                       date(2026, 1, 2), date(2026, 1, 3)],
    })
    tbl.append(data)
    print(f"[bootstrap] appended; rows now = {len(tbl.scan().to_arrow())}")


if __name__ == "__main__":
    main()
