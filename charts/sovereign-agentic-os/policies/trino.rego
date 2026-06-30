# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# Trino -> OPA data-governance policy. This is a SECOND policy doc on the SAME OPA
# that governs agent tools (package agentic.authz is left untouched). The official
# Trino OPA access-control plugin calls:
#   opa.policy.uri                      -> data.trino.allow            (operate)
#   opa.policy.row-filters-uri          -> data.trino.rowFilters       (row filter)
#   opa.policy.column-masking-uri       -> data.trino.columnMask       (column mask)
#   opa.policy.batch-column-masking-uri -> data.trino.batchColumnMask  (wide tables)
#
# Enforcement is NOT hand-authored per table: the row/column rules read the
# domain/visibility model from `data.governance` (tables + principals), which the
# artifact-registry / OpenMetadata visibility sync populates — the same domain +
# visibility + sensitivity model agent governance uses. (The data lives under
# `data.governance`, NOT `data.trino`, so it never collides with the package's own
# rules at `data.trino.*`.)
#
#   data.governance.tables["<catalog>.<schema>.<table>"] = {
#       "domain": "sales",                # owning domain
#       "visibility": "domain"|"shared"|"public"|"private",
#       "shared_with": ["marketing", ...],# domains explicitly granted (visibility=shared)
#       "sensitive_columns": {"<col>": "<sensitivity>"}
#   }
#   data.governance.principals["<user>"] = {"domains": [...], "clearances": [...]}
package trino

import rego.v1

# The engine is allowed to operate; data governance is enforced via row filters +
# column masks below (and tool/domain ACLs via package agentic.authz). A blanket
# deny here would break Trino's own metadata operations.
default allow := true

# Identity carried by the Trino OPA request.
user := input.context.identity.user

# Principal's domain memberships + sensitivity clearances (default: none).
principal := object.get(data.governance.principals, [user], {"domains": [], "clearances": []})

# Fully-qualified table name from a table or column resource.
table_key(r) := sprintf("%s.%s.%s", [r.catalogName, r.schemaName, r.tableName])

# --- Row filtering (by domain) ----------------------------------------------
# A principal NOT entitled to a table's domain gets a `false` row filter (no
# rows). The owning domain — and any `public`/`shared`-to-them table — is
# unfiltered. This is what masks a cross-domain read while the owner sees it.
rowFilters contains {"expression": "false"} if {
	t := input.action.resource.table
	meta := data.governance.tables[table_key(t)]
	not table_entitled(meta)
}

# Entitled = public, or a domain the principal belongs to, or a domain the table
# was explicitly shared with that the principal belongs to.
table_entitled(meta) if meta.visibility == "public"

table_entitled(meta) if domain_member(meta.domain)

table_entitled(meta) if {
	meta.visibility == "shared"
	some d in meta.shared_with
	domain_member(d)
}

# A named individual granted cross-domain (Data tab "shared with specific people").
# The policy compiler emits `shared_with_users` from per-user grants; this minimal
# clause honours them alongside the domain-based entitlement above.
table_entitled(meta) if {
	some u in meta.shared_with_users
	u == user
}

domain_member(domain) if {
	some d in principal.domains
	d == domain
}

# --- Column masking (by sensitivity) ----------------------------------------
# A sensitive column is masked (NULL) unless the principal holds the matching
# sensitivity clearance. Orthogonal to the row filter: the owning domain still
# sees a masked column if it lacks the clearance.
columnMask := {"expression": "NULL"} if {
	c := input.action.resource.column
	meta := data.governance.tables[table_key(c)]
	sensitivity := meta.sensitive_columns[c.columnName]
	not clearance_held(sensitivity)
}

clearance_held(sensitivity) if {
	some c in principal.clearances
	c == sensitivity
}

# Batch form for wide tables (opa.policy.batch-column-masking-uri): emit a mask
# keyed by the column's index in the request's filterResources list.
batchColumnMask contains {"index": i, "viewExpression": {"expression": "NULL"}} if {
	some i, fr in input.action.filterResources
	c := fr.column
	meta := data.governance.tables[table_key(c)]
	sensitivity := meta.sensitive_columns[c.columnName]
	not clearance_held(sensitivity)
}
