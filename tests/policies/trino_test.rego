# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# Unit tests for the Trino->OPA data-governance policy (package trino). These run
# the row-filter + column-mask rules against the official Trino OPA authorizer
# request contract with mock governance data (the same domain/visibility model the
# artifact-registry / OpenMetadata feeds into data.trino in production).
package trino

import rego.v1

# Mock governance data: a Sales mart (domain-scoped) with a PII column, plus two
# principals — the owning Sales agent and a cross-domain Marketing agent.
mock_data := {
	"tables": {
		"iceberg.sales.mart_sales": {
			"domain": "sales",
			"visibility": "domain",
			"shared_with": [],
			"sensitive_columns": {"customer_email": "pii"},
		},
		# The LIVE Northpeak gold mart — keyed under the real `sales` schema
		# (the chart's governance map regression: `iceberg.analytics.*` keys left
		# this table ungoverned).
		"iceberg.sales.gold_northpeak_commerce": {
			"domain": "sales",
			"visibility": "domain",
			"shared_with": [],
			"sensitive_columns": {},
		},
	},
	"principals": {
		"sales-agent": {"domains": ["sales"], "clearances": ["pii"]},
		"marketing-agent": {"domains": ["marketing"], "clearances": []},
		"cube-sales": {"domains": ["sales"], "clearances": []},
	},
}

row_input(user) := {
	"context": {"identity": {"user": user}},
	"action": {
		"operation": "GetRowFilters",
		"resource": {"table": {
			"catalogName": "iceberg",
			"schemaName": "sales",
			"tableName": "mart_sales",
		}},
	},
}

col_input(user) := {
	"context": {"identity": {"user": user}},
	"action": {
		"operation": "GetColumnMask",
		"resource": {"column": {
			"catalogName": "iceberg",
			"schemaName": "sales",
			"tableName": "mart_sales",
			"columnName": "customer_email",
			"columnType": "varchar",
		}},
	},
}

# Owner (in-domain) sees every row — no row filter emitted.
test_owner_sees_all_rows if {
	count(rowFilters) == 0 with input as row_input("sales-agent")
		with data.governance as mock_data
}

# Cross-domain read is masked — the row filter forces `false` (no rows).
test_cross_domain_read_is_masked if {
	rowFilters == {{"expression": "false"}} with input as row_input("marketing-agent")
		with data.governance as mock_data
}

# A PII column is masked for a principal without the matching clearance.
test_pii_masked_without_clearance if {
	columnMask == {"expression": "NULL"} with input as col_input("marketing-agent")
		with data.governance as mock_data
}

# The owner holds the `pii` clearance, so the column is NOT masked.
test_pii_visible_with_clearance if {
	not columnMask with input as col_input("sales-agent")
		with data.governance as mock_data
}

# The engine itself is allowed to operate (governance is row/column, not a deny).
test_engine_allows_by_default if {
	allow with input as {
		"context": {"identity": {"user": "sales-agent"}},
		"action": {"operation": "ExecuteQuery"},
	}
		with data.governance as mock_data
}

# A GetRowFilters request against the live Northpeak gold mart.
mart_row_input(user) := {
	"context": {"identity": {"user": user}},
	"action": {
		"operation": "GetRowFilters",
		"resource": {"table": {
			"catalogName": "iceberg",
			"schemaName": "sales",
			"tableName": "gold_northpeak_commerce",
		}},
	},
}

# Fix-3 regression guard: the LIVE sales mart is governed under its REAL key
# `iceberg.sales.gold_northpeak_commerce` — a cross-domain principal gets the
# `false` row filter (zero rows), instead of reading it fully as happened when
# the governance map keyed it under the dead `iceberg.analytics.*` schema.
test_cross_domain_row_filter_on_live_sales_mart if {
	rowFilters == {{"expression": "false"}} with input as mart_row_input("marketing-agent")
		with data.governance as mock_data
}

# ...while the in-domain service principal (Cube) reads the mart unfiltered.
test_sales_service_principal_reads_mart_unfiltered if {
	count(rowFilters) == 0 with input as mart_row_input("cube-sales")
		with data.governance as mock_data
}

# --- T1.5: personal-schema isolation (hard deny, keyed on the accessing principal) ---

# A read (SelectFromColumns) of `personal_<owner>.bronze_x` by `user`.
personal_read_input(user, owner) := {
	"context": {"identity": {"user": user}},
	"action": {
		"operation": "SelectFromColumns",
		"resource": {"table": {
			"catalogName": "iceberg",
			"schemaName": sprintf("personal_%s", [owner]),
			"tableName": "bronze_x",
			"columns": ["a", "b"],
		}},
	},
}

# A write (CreateTableAsSelect) targeting `personal_<owner>.silver_x` by `user`.
personal_write_input(user, owner) := {
	"context": {"identity": {"user": user}},
	"action": {
		"operation": "CreateTableAsSelect",
		"resource": {"table": {
			"catalogName": "iceberg",
			"schemaName": sprintf("personal_%s", [owner]),
			"tableName": "silver_x",
		}},
	},
}

# Owner reads their OWN personal table -> ALLOW, and no personal row filter applied.
test_owner_reads_own_personal_allow if {
	allow with input as personal_read_input("alex", "alex") with data.governance as mock_data
	count(rowFilters) == 0 with input as personal_read_input("alex", "alex")
		with data.governance as mock_data
}

# Outsider reads another user's personal table -> DENY (hard), and rows forced empty.
test_outsider_reads_personal_deny if {
	not allow with input as personal_read_input("bob", "alex") with data.governance as mock_data
	rowFilters == {{"expression": "false"}} with input as personal_read_input("bob", "alex")
		with data.governance as mock_data
}

# Owner writes their OWN personal schema -> ALLOW.
test_owner_writes_own_personal_allow if {
	allow with input as personal_write_input("alex", "alex") with data.governance as mock_data
}

# Outsider writes into another user's personal schema -> DENY (write isolation too).
test_outsider_writes_personal_deny if {
	not allow with input as personal_write_input("bob", "alex") with data.governance as mock_data
}

# An email-form principal maps to the sanitized personal schema and is recognised as
# its owner; a different email is denied.
test_email_principal_owns_sanitized_schema if {
	allow with input as personal_read_input("alex@datamasterclass.com", "alex_datamasterclass_com")
		with data.governance as mock_data
	not allow with input as personal_read_input("bob@datamasterclass.com", "alex_datamasterclass_com")
		with data.governance as mock_data
}

# Missing identity fails CLOSED for a personal schema.
test_missing_identity_denies_personal if {
	not allow with input as {"action": {
		"operation": "SelectFromColumns",
		"resource": {"table": {"catalogName": "iceberg", "schemaName": "personal_alex", "tableName": "bronze_x"}},
	}}
		with data.governance as mock_data
}

# A normal domain-schema read is UNAFFECTED by the personal rule: the owning domain is
# allowed with no row filter (governance behaves exactly as before).
test_domain_read_unaffected if {
	allow with input as row_input("sales-agent") with data.governance as mock_data
	count(rowFilters) == 0 with input as row_input("sales-agent") with data.governance as mock_data
}

# Batch column masking (wide tables): the sensitive column is masked by index.
test_batch_column_mask if {
	got := batchColumnMask with input as {
		"context": {"identity": {"user": "marketing-agent"}},
		"action": {
			"operation": "GetColumnMask",
			"filterResources": [
				{"column": {
					"catalogName": "iceberg", "schemaName": "sales",
					"tableName": "mart_sales", "columnName": "region", "columnType": "varchar",
				}},
				{"column": {
					"catalogName": "iceberg", "schemaName": "sales",
					"tableName": "mart_sales", "columnName": "customer_email", "columnType": "varchar",
				}},
			],
		},
	}
		with data.governance as mock_data
	got == {{"index": 1, "viewExpression": {"expression": "NULL"}}}
}

# --- T8: promotion release (one-time, single-reader, READ-ONLY personal exemption) ---
# The approval flow pushes data.governance.releases["personal_<owner>"] = {reader}
# just before the publish CTAS (run as the approving Builder) and withdraws it after.

release_data := object.union(mock_data, {"releases": {"personal_alex": {
	"reader": "bea",
	"fqn": "iceberg.personal_alex.gold_orders",
}}})

# The named reader may READ the released personal schema (allow + no row filter),
# so the publish CTAS copies the real rows — never a silent empty table.
test_release_reader_reads_released_personal_allow if {
	allow with input as personal_read_input("bea", "alex") with data.governance as release_data
	count(rowFilters) == 0 with input as personal_read_input("bea", "alex")
		with data.governance as release_data
}

# Anyone else is still hard-denied while the release is live.
test_release_other_user_still_denied if {
	not allow with input as personal_read_input("bob", "alex") with data.governance as release_data
	rowFilters == {{"expression": "false"}} with input as personal_read_input("bob", "alex")
		with data.governance as release_data
}

# The reader gains nothing on any OTHER personal schema.
test_release_reader_other_schema_still_denied if {
	not allow with input as personal_read_input("bea", "carol") with data.governance as release_data
}

# The release is READ-ONLY: a write into the released schema stays denied.
test_release_is_read_only_write_still_denied if {
	not allow with input as personal_write_input("bea", "alex") with data.governance as release_data
}

# The owner keeps full access during the release window.
test_release_owner_still_owns if {
	allow with input as personal_read_input("alex", "alex") with data.governance as release_data
	allow with input as personal_write_input("alex", "alex") with data.governance as release_data
}
