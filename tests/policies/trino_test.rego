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
	"tables": {"iceberg.sales.mart_sales": {
		"domain": "sales",
		"visibility": "domain",
		"shared_with": [],
		"sensitive_columns": {"customer_email": "pii"},
	}},
	"principals": {
		"sales-agent": {"domains": ["sales"], "clearances": ["pii"]},
		"marketing-agent": {"domains": ["marketing"], "clearances": []},
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
