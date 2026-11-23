# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# Ungoverned tables in a DOMAIN schema (trino.rego "Ungoverned tables in a DOMAIN schema"):
# a table with no `data.governance.tables` entry in `iceberg.<domain schema>` is reachable only
# by members of that domain and by Trino service identities.
package trino

import rego.v1

ug_data := {
	"tables": {
		# The governed gold of a Domain dataset (domain-scoped, one masked column).
		"iceberg.sales.gold_orders": {
			"domain": "sales",
			"visibility": "domain",
			"shared_with": [],
			"shared_with_users": [],
			"sensitive_columns": {"email": "restricted"},
		},
		# A Company data product in a domain schema (readable by all, masks apply).
		"iceberg.sales.gold_company_kpis": {
			"domain": "sales",
			"visibility": "public",
			"shared_with": [],
			"shared_with_users": [],
			"sensitive_columns": {"email": "restricted"},
		},
	},
	"principals": {
		"alice": {"domains": ["sales"], "clearances": []},
		"bob": {"domains": ["marketing"], "clearances": []},
		"carol": {"domains": ["agentic-leader-q3"], "clearances": []},
		"sales": {"domains": ["sales"], "clearances": []},
		"marketing": {"domains": ["marketing"], "clearances": []},
		"agentic-leader-q3": {"domains": ["agentic-leader-q3"], "clearances": []},
	},
}

ug_svc := {
	"prefixes": ["svc-"],
	"names": ["svc-dagster-runner", "svc-os-ui", "svc-os-worker", "dbt-runner", "northpeak-marts", "os-domain-delete", "query-agent"],
	"impersonators": ["svc-dagster-runner", "svc-os-ui", "svc-os-worker"],
}

ug_tbl(schema, table) := {"catalogName": "iceberg", "schemaName": schema, "tableName": table}

ug_select(user, schema, table) := {
	"context": {"identity": {"user": user}},
	"action": {
		"operation": "SelectFromColumns",
		"resource": {"table": object.union(ug_tbl(schema, table), {"columns": ["id"]})},
	},
}

ug_filter_tables(user, schema, table) := {
	"context": {"identity": {"user": user}},
	"action": {"operation": "FilterTables", "resource": {"table": ug_tbl(schema, table)}},
}

ug_filter_columns(user, schema, table) := {
	"context": {"identity": {"user": user}},
	"action": {
		"operation": "FilterColumns",
		"resource": {"table": object.union(ug_tbl(schema, table), {"columns": ["id"]})},
	},
}

ug_show_columns(user, schema, table) := {
	"context": {"identity": {"user": user}},
	"action": {"operation": "ShowColumns", "resource": {"table": ug_tbl(schema, table)}},
}

ug_rows(user, schema, table) := {
	"context": {"identity": {"user": user}},
	"action": {"operation": "GetRowFilters", "resource": {"table": ug_tbl(schema, table)}},
}

ug_mask(user, table) := {
	"context": {"identity": {"user": user}},
	"action": {"operation": "GetColumnMask", "resource": {"column": {
		"catalogName": "iceberg", "schemaName": "sales", "tableName": table,
		"columnName": "email", "columnType": "varchar",
	}}},
}

# A user of another domain can neither read nor list nor describe an ungoverned silver table.
test_foreign_user_cannot_select_ungoverned_silver if {
	not allow with input as ug_select("bob", "sales", "silver_orders") with data.governance as ug_data
		with data.service_identities as ug_svc
	rowFilters == {{"expression": "false"}} with input as ug_rows("bob", "sales", "silver_orders")
		with data.governance as ug_data with data.service_identities as ug_svc
}

test_foreign_user_cannot_list_ungoverned_silver if {
	not allow with input as ug_filter_tables("bob", "sales", "silver_orders") with data.governance as ug_data
		with data.service_identities as ug_svc
	not allow with input as ug_filter_columns("bob", "sales", "silver_orders") with data.governance as ug_data
		with data.service_identities as ug_svc
	not allow with input as ug_show_columns("bob", "sales", "silver_orders") with data.governance as ug_data
		with data.service_identities as ug_svc
}

# Batch-form filter resources are covered too.
test_foreign_user_batch_filter_denied if {
	not allow with input as {
		"context": {"identity": {"user": "bob"}},
		"action": {"operation": "FilterTables", "filterResources": [{"table": ug_tbl("sales", "silver_orders")}]},
	}
		with data.governance as ug_data with data.service_identities as ug_svc
}

# Members of the owning domain keep full access to their own ungoverned tables.
test_own_domain_member_reads_ungoverned_silver if {
	allow with input as ug_select("alice", "sales", "silver_orders") with data.governance as ug_data
		with data.service_identities as ug_svc
	allow with input as ug_filter_tables("alice", "sales", "silver_orders") with data.governance as ug_data
		with data.service_identities as ug_svc
	count(rowFilters) == 0 with input as ug_rows("alice", "sales", "silver_orders")
		with data.governance as ug_data with data.service_identities as ug_svc
}

# The domain principal of the owning domain is a member; another domain's principal is not.
test_domain_principals if {
	allow with input as ug_select("sales", "sales", "silver_orders") with data.governance as ug_data
		with data.service_identities as ug_svc
	not allow with input as ug_select("marketing", "sales", "silver_orders") with data.governance as ug_data
		with data.service_identities as ug_svc
	rowFilters == {{"expression": "false"}} with input as ug_rows("marketing", "sales", "silver_orders")
		with data.governance as ug_data with data.service_identities as ug_svc
}

# A hyphenated domain owns the sanitized schema (`agentic-leader-q3` -> `agentic_leader_q3`).
test_hyphenated_domain_schema if {
	allow with input as ug_select("carol", "agentic_leader_q3", "silver_x") with data.governance as ug_data
		with data.service_identities as ug_svc
	allow with input as ug_select("agentic-leader-q3", "agentic_leader_q3", "silver_x") with data.governance as ug_data
		with data.service_identities as ug_svc
	not allow with input as ug_select("alice", "agentic_leader_q3", "silver_x") with data.governance as ug_data
		with data.service_identities as ug_svc
}

# A Company product (public) is readable by every domain, with masks still applied.
test_company_public_table_readable_by_all_with_masks if {
	allow with input as ug_select("bob", "sales", "gold_company_kpis") with data.governance as ug_data
		with data.service_identities as ug_svc
	count(rowFilters) == 0 with input as ug_rows("bob", "sales", "gold_company_kpis")
		with data.governance as ug_data with data.service_identities as ug_svc
	columnMask == {"expression": "NULL"} with input as ug_mask("bob", "gold_company_kpis")
		with data.governance as ug_data with data.service_identities as ug_svc
}

# A governed domain table behaves as before: allowed operation, row filter for outsiders only.
test_governed_domain_table_unchanged if {
	allow with input as ug_select("bob", "sales", "gold_orders") with data.governance as ug_data
		with data.service_identities as ug_svc
	rowFilters == {{"expression": "false"}} with input as ug_rows("bob", "sales", "gold_orders")
		with data.governance as ug_data with data.service_identities as ug_svc
	count(rowFilters) == 0 with input as ug_rows("alice", "sales", "gold_orders")
		with data.governance as ug_data with data.service_identities as ug_svc
}

# Personal schemas keep their hard deny (and are not a domain schema).
test_personal_hard_deny_unchanged if {
	not allow with input as ug_select("alice", "personal_bob", "bronze_x") with data.governance as ug_data
		with data.service_identities as ug_svc
	allow with input as ug_select("bob", "personal_bob", "bronze_x") with data.governance as ug_data
		with data.service_identities as ug_svc
}

# Service identities (dbt builds, the query tool, os-ui's own system queries) keep working.
test_service_principals_still_work if {
	allow with input as ug_select("dbt-runner", "sales", "silver_orders") with data.governance as ug_data
		with data.service_identities as ug_svc
	allow with input as ug_select("northpeak-marts", "sales", "silver_orders") with data.governance as ug_data
		with data.service_identities as ug_svc
	allow with input as ug_filter_tables("svc-os-ui", "sales", "silver_orders") with data.governance as ug_data
		with data.service_identities as ug_svc
	count(rowFilters) == 0 with input as ug_rows("dbt-runner", "sales", "silver_orders")
		with data.governance as ug_data with data.service_identities as ug_svc
}

# The query tool's no-principal session user (its own MCP tools) is NOT exempt.
test_query_agent_denied_on_foreign_ungoverned if {
	not allow with input as ug_select("query-agent", "sales", "silver_orders") with data.governance as ug_data
		with data.service_identities as ug_svc
	not allow with input as ug_filter_tables("query-agent", "sales", "silver_orders") with data.governance as ug_data
		with data.service_identities as ug_svc
	rowFilters == {{"expression": "false"}} with input as ug_rows("query-agent", "sales", "silver_orders")
		with data.governance as ug_data with data.service_identities as ug_svc
}

# --- Iceberg metadata tables follow their base table ---

ug_shared_data := object.union(ug_data, {"tables": {"iceberg.sales.gold_shared": {
	"domain": "sales",
	"visibility": "shared",
	"shared_with": ["marketing"],
	"shared_with_users": [],
	"sensitive_columns": {},
}}})

# Shared and public consumers read the version history (`$snapshots`, `$refs`) of the base.
test_entitled_consumer_reads_metadata_of_governed_base if {
	allow with input as ug_select("bob", "sales", "gold_shared$snapshots") with data.governance as ug_shared_data
		with data.service_identities as ug_svc
	allow with input as ug_select("marketing", "sales", "gold_shared$refs") with data.governance as ug_shared_data
		with data.service_identities as ug_svc
	allow with input as ug_select("bob", "sales", "gold_company_kpis$snapshots") with data.governance as ug_shared_data
		with data.service_identities as ug_svc
	allow with input as ug_select("alice", "sales", "gold_orders$snapshots") with data.governance as ug_shared_data
		with data.service_identities as ug_svc
}

# A non-entitled domain cannot read any metadata table of a domain-only base.
test_non_entitled_denied_metadata_of_domain_only_base if {
	not allow with input as ug_select("bob", "sales", "gold_orders$partitions") with data.governance as ug_data
		with data.service_identities as ug_svc
	not allow with input as ug_select("marketing", "sales", "gold_orders$files") with data.governance as ug_data
		with data.service_identities as ug_svc
	not allow with input as ug_select("query-agent", "sales", "gold_orders$snapshots") with data.governance as ug_data
		with data.service_identities as ug_svc
}

# A metadata table of an UNGOVERNED base is reachable only by the domain's members.
test_metadata_of_ungoverned_base_members_only if {
	not allow with input as ug_select("bob", "sales", "silver_orders$snapshots") with data.governance as ug_data
		with data.service_identities as ug_svc
	allow with input as ug_select("alice", "sales", "silver_orders$snapshots") with data.governance as ug_data
		with data.service_identities as ug_svc
}

# The impersonate-only service users gain nothing from the service exemption.
test_impersonate_only_still_denied if {
	not allow with input as ug_select("svc-dagster-runner", "sales", "silver_orders") with data.governance as ug_data
		with data.service_identities as ug_svc
}

# A schema that maps to no known domain, and non-iceberg catalogs, are untouched by this floor.
test_non_domain_schema_untouched if {
	allow with input as ug_select("bob", "information_schema", "tables") with data.governance as ug_data
		with data.service_identities as ug_svc
	allow with input as {
		"context": {"identity": {"user": "bob"}},
		"action": {"operation": "SelectFromColumns", "resource": {"table": {"catalogName": "system", "schemaName": "sales", "tableName": "x"}}},
	}
		with data.governance as ug_data with data.service_identities as ug_svc
}

# No identity fails closed on an ungoverned domain table.
test_missing_identity_denied if {
	not allow with input as {"action": {"operation": "SelectFromColumns", "resource": {"table": ug_tbl("sales", "silver_orders")}}}
		with data.governance as ug_data with data.service_identities as ug_svc
}
