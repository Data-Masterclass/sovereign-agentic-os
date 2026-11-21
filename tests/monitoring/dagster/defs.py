# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# A tiny code location for the Monitoring panel tests: three assets in a chain
# (sales/stg_orders -> sales/orders -> sales/orders_mart), two asset checks on sales/orders (the
# shape dagster-dbt gives a dbt model with tests), a job and a schedule named like the OS's
# (<domain>__<dataset>), and a job that always fails. Plain Dagster APIs only.
import os

from dagster import (AssetCheckResult, AssetKey, Definitions, ScheduleDefinition, asset, asset_check,
                     define_asset_job, job, op)


@asset(key=["sales", "stg_orders"], group_name="sales")
def stg_orders():
    return 1


@asset(key=["sales", "orders"], deps=[AssetKey(["sales", "stg_orders"])], group_name="sales")
def orders():
    return 2


@asset(key=["sales", "orders_mart"], deps=[AssetKey(["sales", "orders"])], group_name="sales")
def orders_mart():
    return 3


@asset_check(asset=AssetKey(["sales", "orders"]), name="unique_orders_id")
def unique_orders_id():
    return AssetCheckResult(passed=True)


@asset_check(asset=AssetKey(["sales", "orders"]), name="not_null_orders_id")
def not_null_orders_id():
    # The seed runs this twice: passing, then failing — a trend with two points.
    return AssetCheckResult(passed=os.environ.get("FX_CHECK_PASS") == "1", description="3 null ids")


orders_job = define_asset_job("sales__orders", selection=["sales/stg_orders", "sales/orders", "sales/orders_mart"])


@op
def explode():
    raise RuntimeError("source table missing")


@job(name="sales__broken")
def broken_job():
    explode()


defs = Definitions(
    assets=[stg_orders, orders, orders_mart],
    asset_checks=[unique_orders_id, not_null_orders_id],
    jobs=[orders_job, broken_job],
    schedules=[ScheduleDefinition(name="sales__orders_schedule", job=orders_job, cron_schedule="0 3 * * *")],
)
