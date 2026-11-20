# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# The dual-run rule (trino_legacy_http.rego): while Trino's plain-HTTP port is still open for
# the clients that have not moved to TLS, the password-less `dbt-runner` keeps today's
# impersonation (bounded by the chained file ACL, as today). The chart loads that file only
# while the port is open; tests/lakehouse/auth.int.test.mjs proves the closed state on Trino.
package trino_test

import rego.v1

import data.trino

test_legacy_dbt_runner_keeps_dual_run_impersonation if {
	trino.allow with input as imp("dbt-runner", "sales") with data.os_data as {"users": {}}
}

test_legacy_rule_names_one_user_only if not allowed("dbt-runner2", "sales")
