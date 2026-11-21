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

    def test_exact_names_only_a_new_trino_or_dbt_variable_stays_invisible(self):
        # Twin of a prefix rule: a credential that merely LOOKS like a dbt or Trino setting.
        pod = {"TRINO_HOST": "trino", "TRINO_PASSWORD": "x", "TRINO_ADMIN_TOKEN": "x",
               "DBT_ENV_CUSTOM_ENV_SECRET": "x", "DBT_ENV_SECRET_OTHER": "x", "DBT_CLOUD_API_KEY": "x",
               "LC_SECRET": "x", "DBT_ENV_SECRET_TRINO_PASSWORD": "dbt-guards-this"}
        self.assertEqual(sorted(osp.dbt_run_env(pod)), ["DBT_ENV_SECRET_TRINO_PASSWORD", "TRINO_HOST"])

    def test_the_run_identity_variables_reach_dbt(self):
        # WP-15: act_as_owner sets these two; the profile reads them, so they must pass.
        self.assertEqual(sorted(osp.dbt_run_env({"OS_PRINCIPAL": "bea", "DBT_ENV_SECRET_TRINO_PASSWORD": "pw", "TRINO_TLS_PORT": "8443", "TRINO_RUNNER_USER": "svc", "TRINO_CA_FILE": "/c"})),
                         ["DBT_ENV_SECRET_TRINO_PASSWORD", "OS_PRINCIPAL", "TRINO_CA_FILE", "TRINO_RUNNER_USER", "TRINO_TLS_PORT"])


if __name__ == "__main__":
    unittest.main()
