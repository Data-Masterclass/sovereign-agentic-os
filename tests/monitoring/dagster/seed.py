# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# Seed the Monitoring panel tests' Dagster instance with real runs, through Dagster's own API:
#   1. sales__orders, tagged as the OS tags a dataset run (os/dataset, os/domain, os/principal) and
#      as a schedule tick (dagster/schedule_name) — the not_null check PASSES;
#   2. the same job again — the not_null check FAILS (non-blocking, so the run still succeeds);
#   3. sales__broken for dataset `orders` — the run FAILS;
#   4. sales__orders for dataset `secret_ds` of domain `hr` — the negative twin for scope.
import os

from dagster import DagsterInstance

import defs as fx

instance = DagsterInstance.get()
tags = {"os/dataset": "orders", "os/domain": "sales", "os/principal": "ada", "dagster/schedule_name": "sales__orders_schedule"}

os.environ["FX_CHECK_PASS"] = "1"
fx.defs.get_job_def("sales__orders").execute_in_process(instance=instance, tags=tags)
os.environ["FX_CHECK_PASS"] = "0"
fx.defs.get_job_def("sales__orders").execute_in_process(instance=instance, tags=tags)
fx.defs.get_job_def("sales__broken").execute_in_process(instance=instance, tags={"os/dataset": "orders", "os/domain": "sales", "os/principal": "ada"}, raise_on_error=False)
fx.defs.get_job_def("sales__orders").execute_in_process(instance=instance, tags={"os/dataset": "secret_ds", "os/domain": "hr", "os/principal": "zoe"})
print("seeded")
