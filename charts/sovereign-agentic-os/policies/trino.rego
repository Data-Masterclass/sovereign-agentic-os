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

# --- Write-target guard (ADDITIVE floor for the governed /execute write path) ---
# AUTHORITATIVE write authorization lives in the query-tool (execute_guard.py): it
# holds the caller's uid + ROLE, enforces the statement allowlist, the role floor
# (builder for domain schemas) and personal_<uid> OWNERSHIP. The Trino session
# identity here is only the DOMAIN principal, and `data.trino.allow` is intentionally
# permissive, so this clause cannot express role/uid — it is a SECOND, coarser floor:
# a GOVERNED principal (one the policy compiler declares with domains) may only run
# write DDL against a schema it is entitled to — one of its own domains, or a
# `personal_*` sandbox schema. This is purely additive: it only ever DENIES, and only
# for governed principals; unknown/system writers (any principal absent from
# data.governance.principals — the sales-lane service principals like `northpeak-marts`
# ARE declared there now) keep the existing default-allow, so it never loosens policy
# or breaks existing writes.
write_operations := {
	"CreateSchema", "DropSchema",
	"CreateTable", "CreateTableAsSelect", "DropTable",
	"InsertIntoTable", "DeleteFromTable", "TruncateTable",
}

is_write_op if input.action.operation in write_operations

# A principal the governance model knows about (has declared domains).
governed_principal if count(principal.domains) > 0

# Target schema of the write (table ops carry a `table` resource; schema ops a `schema`).
write_schema := s if {
	t := input.action.resource.table
	s := t.schemaName
}

write_schema := s if {
	not input.action.resource.table
	sc := input.action.resource.schema
	s := sc.schemaName
}

write_target_entitled if write_schema in principal.domains

# os-ui mints a domain's mart SCHEMA as sanitizeIdent(domain) (store-fqn.domainSchema),
# so a hyphenated domain `agentic-leader-q3-2026` writes to schema `agentic_leader_q3_2026`.
# Entitle the write when a declared domain sanitizes to the target schema (byte-identical
# to the minting rule) — otherwise a governed principal could never write its own mart.
write_target_entitled if {
	some d in principal.domains
	sanitize_ident(d) == write_schema
}

write_target_entitled if startswith(write_schema, "personal_")

allow := false if {
	is_write_op
	governed_principal
	not write_target_entitled
}

# --- Personal-schema isolation (T1.5 — ADDITIVE hard deny, keyed on the principal) --
# The personal lane (`iceberg.personal_<uid>.*`) is where students upload private
# files. Those tables have NO `data.governance.tables` entry, so the domain-based row
# filter below never touches them — WITHOUT this rule ANY authenticated principal could
# read (or write) another user's personal schema through the governed query path. This
# is a HARD DENY on the whole schema (not a row filter): a `personal_<x>` schema is
# private to `<x>` alone.
#
# Ownership is decided ENTIRELY from the Trino session user (the accessing principal),
# so it cannot be spoofed by a request field — the query-tool sets the Trino session
# `user` to the caller's session-derived principal, and os-ui mints the schema name as
# `personal_<sanitizeIdent(uid)>` (store-fqn.ts) / `personal_<sanitize>(uid)`
# (execute_guard.py). We reproduce that SAME sanitization here so the in-rego owner
# schema is byte-identical to the minted schema (handles a raw email uid too).
#
# Purely additive: it ONLY ever DENIES, and ONLY for a `personal_*` schema the caller
# does not own — non-personal (domain/shared/public) schemas are governed exactly as
# before, and a system/service writer (marts job, dbt) never targets `personal_*`.

# Sanitize an identity to the same stable form os-ui/query-tool use to mint the schema:
# lowercase, collapse each run of non-[a-z0-9] to '_', strip leading/trailing '_',
# empty -> "user". (Mirrors sanitizeIdent / personal_schema exactly.)
sanitize_ident(v) := s if {
	trimmed := trim(regex.replace(lower(v), `[^a-z0-9]+`, "_"), "_")
	trimmed != ""
	s := trimmed
}

sanitize_ident(v) := "user" if {
	trim(regex.replace(lower(v), `[^a-z0-9]+`, "_"), "_") == ""
}

# The accessing principal owns EXACTLY this one personal schema.
is_owned_personal(schema) if schema == sprintf("personal_%s", [sanitize_ident(user)])

# --- Promotion release (T8 — publish on approval) -----------------------------------
# An approved `dataset_promote` must COPY the requester's personal-lane gold/silver
# table into the governed domain schema, and the publish CTAS runs AS THE APPROVING
# BUILDER (separation of duties — never the requester). That read would hit the hard
# deny below, so os-ui pushes a ONE-TIME release right before the publish CTAS and
# withdraws it immediately after (any straggler is wiped by the next full
# `data.governance` PUT, which carries no `releases` key):
#
#   data.governance.releases["personal_<owner>"] = {"reader": "<approver>", "fqn": ...}
#
# The exemption is deliberately NARROW: READ-ONLY (never a write operation), exactly
# ONE schema, exactly ONE reader. Everything else about the personal lane — including
# writes by the releasee during the window — stays hard-denied.
released_to_reader(schema) if {
	not is_write_op
	rel := data.governance.releases[schema]
	rel.reader == user
}

# Every schema the action references (covers BOTH the schema-visibility entry point and
# the table-read/write entry points, plus rename `targetResource` and batch
# `filterResources`, so a personal table can't be reached by any path). A path that is
# absent from the request simply contributes nothing.
accessed_schemas contains s if s := input.action.resource.table.schemaName

accessed_schemas contains s if s := input.action.resource.schema.schemaName

accessed_schemas contains s if s := input.action.resource.column.schemaName

accessed_schemas contains s if s := input.action.targetResource.table.schemaName

accessed_schemas contains s if s := input.action.targetResource.schema.schemaName

accessed_schemas contains s if {
	some fr in input.action.filterResources
	s := fr.table.schemaName
}

accessed_schemas contains s if {
	some fr in input.action.filterResources
	s := fr.column.schemaName
}

# HARD DENY: any access (read OR write) to a `personal_*` schema the caller does not
# own. `not is_owned_personal(...)` fails CLOSED — if the request carries no identity,
# `user`/`sanitize_ident` are undefined, `is_owned_personal` is false, and access is
# denied. Composes with the write floor above (both assign `allow := false`).
allow := false if {
	some schema in accessed_schemas
	startswith(schema, "personal_")
	not is_owned_personal(schema)
	not released_to_reader(schema)
}

# Defense-in-depth on the row-filter entry point: even if a future config only wires
# the row-filters URI, a non-owned personal table yields zero rows. The promotion
# release exempts here too — otherwise a released publish read would silently copy
# ZERO rows into the domain table (a wrong-data outcome worse than a denial).
rowFilters contains {"expression": "false"} if {
	t := input.action.resource.table
	startswith(t.schemaName, "personal_")
	not is_owned_personal(t.schemaName)
	not released_to_reader(t.schemaName)
}

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
