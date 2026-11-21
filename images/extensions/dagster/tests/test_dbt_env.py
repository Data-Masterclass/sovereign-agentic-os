# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
"""`os_projects.dbt_run_env`: the env a dbt run inherits is an allowlist (the real dbt proof is
tests/image/dbt_env.py)."""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import os_projects as osp  # noqa: E402


class DbtRunEnv(unittest.TestCase):
    def test_keeps_dbt_trino_and_process_basics_drops_everything_else(self):
        pod = {
            "PATH": "/usr/bin", "HOME": "/tmp", "LC_ALL": "C.UTF-8", "OS_PRINCIPAL": "bea",
            "DBT_ENV_SECRET_TRINO_PASSWORD": "dbt-guards-this", "DBT_PROFILES_DIR": "/p",
            "TRINO_HOST": "trino", "TRINO_CA_FILE": "/ca.crt",
            "DAGSTER_PG_PASSWORD": "x", "AGENT_RUNTIME_TOKEN": "x", "AWS_SECRET_ACCESS_KEY": "x",
            "DESTINATION__SQLALCHEMY__CREDENTIALS__PASSWORD": "x", "KUBERNETES_SERVICE_HOST": "x",
            "OS_PINNED_COMMITS": "sales=abc", "DAGSTER_HOME": "/dh",
        }
        self.assertEqual(sorted(osp.dbt_run_env(pod)), sorted([
            "PATH", "HOME", "LC_ALL", "OS_PRINCIPAL", "DBT_ENV_SECRET_TRINO_PASSWORD", "DBT_PROFILES_DIR", "TRINO_HOST", "TRINO_CA_FILE",
        ]))


if __name__ == "__main__":
    unittest.main()
