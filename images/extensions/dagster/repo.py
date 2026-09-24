# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
"""Dagster definitions — the orchestrator's user code.

Loads the dbt project as Dagster assets (dagster-dbt) so Dagster orchestrates
the warehouse build, plus a tiny proof-of-life asset. Materializing the dbt
assets runs `dbt build` against the CNPG `warehouse` (creds come from the run
pod's env: PGHOST/PGDATABASE + the warehouse Secret via envSecrets).
"""
from pathlib import Path

from dagster import Definitions, asset
from dagster_dbt import DbtCliResource, dbt_assets

DBT_DIR = Path("/opt/dbt/project")
MANIFEST = DBT_DIR / "target" / "manifest.json"


@asset(group_name="sovereign_os", description="Proof-of-life asset for the orchestrator.")
def hello_sovereign() -> str:
    return "hello from the Sovereign Agentic OS orchestrator"


@dbt_assets(manifest=MANIFEST)
def sovereign_dbt(context, dbt: DbtCliResource):
    yield from dbt.cli(["build"], context=context).stream()


defs = Definitions(
    assets=[hello_sovereign, sovereign_dbt],
    resources={
        "dbt": DbtCliResource(project_dir=str(DBT_DIR), profiles_dir=str(DBT_DIR)),
    },
)
