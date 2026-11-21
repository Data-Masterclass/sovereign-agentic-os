# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# Unit tests for the Trino `ImpersonateUser` rules (WP-14; design 06 §5.4, amended by 10 F4).
# The request shape is the Trino 476 OPA plugin's: the authenticated (original) identity in
# `context.identity.user`, the requested session user in `action.resource.user.user`
# (https://trino.io/docs/476/security/opa-access-control.html). The same shape is proven on a
# real Trino in tests/lakehouse/impersonation.int.test.mjs.
package trino_test

import rego.v1

import data.trino

future := "2200-01-01T00:00:00Z"

past := "2000-01-01T00:00:00Z"

imp(original, target) := {
	"context": {"identity": {"user": original, "groups": []}},
	"action": {
		"operation": "ImpersonateUser",
		"resource": {"user": {"user": target}},
	},
}

grants := {
	"g-run": {"principal_uid": "alice@x.com", "kind": "run", "active_run_id": null, "expires_at": future, "revoked": false},
	"g-run-expired": {"principal_uid": "erin@x.com", "kind": "run", "expires_at": past, "revoked": false},
	"g-run-revoked": {"principal_uid": "rob@x.com", "kind": "run", "expires_at": future, "revoked": true},
	"g-run-no-expiry": {"principal_uid": "nora@x.com", "kind": "run", "revoked": false},
	"g-standing-active": {"principal_uid": "dana@x.com", "kind": "standing", "active_run_id": "run-1", "active_until": future, "expires_at": future},
	"g-dataset-active": {"principal_uid": "dave@x.com", "kind": "dataset", "active_run_id": "run-2", "active_until": future, "expires_at": future},
	# WP-15: a missed /finish closes itself — `active_until` in the past, or absent, is not active.
	"g-standing-window-over": {"principal_uid": "wes@x.com", "kind": "standing", "active_run_id": "run-4", "active_until": past, "expires_at": future},
	"g-standing-no-window": {"principal_uid": "nina@x.com", "kind": "standing", "active_run_id": "run-5", "expires_at": future},
	"g-standing-idle": {"principal_uid": "ida@x.com", "kind": "standing", "active_run_id": null, "expires_at": future},
	"g-standing-empty-run": {"principal_uid": "eve@x.com", "kind": "standing", "active_run_id": "", "expires_at": future},
	"g-standing-expired": {"principal_uid": "sam@x.com", "kind": "standing", "active_run_id": "run-3", "active_until": future, "expires_at": past},
}

os_data := {"users": {
	"alice@x.com": {"active": true},
	"bob@x.com": {"active": false},
	"carol@x.com": {"active": true},
}}

# Today's governance principals (users, domain self-principals, chart seeds): the session users
# the governed door sends before WP-35 switches every caller to the uid.
governance := {"principals": {
	"sales": {"domains": ["sales"], "clearances": []},
	"u-legacy@x.com": {"domains": ["sales"], "clearances": []},
	"svc-os-worker": {"domains": [], "clearances": []},
}}

# ---- svc-os-worker: only the principal of an active, unexpired, unrevoked `kind=run` grant ----

test_worker_acts_for_run_grant_principal if trino.allow with input as imp("svc-os-worker", "alice@x.com") with data.os_grants.run_grants as grants with data.os_data as os_data with data.governance as governance

test_worker_denied_without_grant if not trino.allow with input as imp("svc-os-worker", "carol@x.com") with data.os_grants.run_grants as grants with data.os_data as os_data with data.governance as governance

test_worker_denied_expired_grant if not trino.allow with input as imp("svc-os-worker", "erin@x.com") with data.os_grants.run_grants as grants with data.os_data as os_data with data.governance as governance

test_worker_denied_revoked_grant if not trino.allow with input as imp("svc-os-worker", "rob@x.com") with data.os_grants.run_grants as grants with data.os_data as os_data with data.governance as governance

test_worker_denied_grant_without_expiry if not trino.allow with input as imp("svc-os-worker", "nora@x.com") with data.os_grants.run_grants as grants with data.os_data as os_data with data.governance as governance

# 10 F4 kind binding: the worker cannot use a Dagster (standing/dataset) grant.
test_worker_denied_dagster_grant if not trino.allow with input as imp("svc-os-worker", "dana@x.com") with data.os_grants.run_grants as grants with data.os_data as os_data with data.governance as governance

# ---- svc-dagster-runner: only a standing|dataset grant with an active run ----

test_dagster_acts_for_standing_grant_in_run if trino.allow with input as imp("svc-dagster-runner", "dana@x.com") with data.os_grants.run_grants as grants with data.os_data as os_data with data.governance as governance

test_dagster_acts_for_dataset_grant_in_run if trino.allow with input as imp("svc-dagster-runner", "dave@x.com") with data.os_grants.run_grants as grants with data.os_data as os_data with data.governance as governance

test_dagster_denied_standing_grant_between_runs if not trino.allow with input as imp("svc-dagster-runner", "ida@x.com") with data.os_grants.run_grants as grants with data.os_data as os_data with data.governance as governance

test_dagster_denied_empty_run_id if not trino.allow with input as imp("svc-dagster-runner", "eve@x.com") with data.os_grants.run_grants as grants with data.os_data as os_data with data.governance as governance

test_dagster_denied_expired_standing_grant if not trino.allow with input as imp("svc-dagster-runner", "sam@x.com") with data.os_grants.run_grants as grants with data.os_data as os_data with data.governance as governance

# 10 F4 kind binding: the Dagster runner cannot use an agent (kind=run) grant.
test_dagster_denied_agent_grant if not trino.allow with input as imp("svc-dagster-runner", "alice@x.com") with data.os_grants.run_grants as grants with data.os_data as os_data with data.governance as governance

# 10 F4: there is no schedule_principals path — a name with no grant is denied.
test_dagster_no_schedule_principals_path if {
	not trino.allow with input as imp("svc-dagster-runner", "sales")
		with data.os_grants.run_grants as grants
		with data.os_data as {"users": {}, "schedule_principals": ["sales"]}
		with data.governance as governance
}

# ---- svc-os-ui (interim, removed at T7): the active user, or a declared governance principal ----

test_ui_acts_for_active_user if trino.allow with input as imp("svc-os-ui", "carol@x.com") with data.os_grants.run_grants as grants with data.os_data as os_data with data.governance as governance

test_ui_denied_inactive_user if not trino.allow with input as imp("svc-os-ui", "bob@x.com") with data.os_grants.run_grants as grants with data.os_data as os_data with data.governance as governance

test_ui_denied_unknown_identity if not trino.allow with input as imp("svc-os-ui", "mallory@x.com") with data.os_grants.run_grants as grants with data.os_data as os_data with data.governance as governance

test_ui_acts_for_declared_domain_principal if trino.allow with input as imp("svc-os-ui", "sales") with data.os_grants.run_grants as grants with data.os_data as os_data with data.governance as governance

test_ui_acts_for_declared_user_principal if trino.allow with input as imp("svc-os-ui", "u-legacy@x.com") with data.os_grants.run_grants as grants with data.os_data as os_data with data.governance as governance

# svc-os-ui is interactive only: no grant reaches it, and no service identity is a target.
test_ui_denied_grant_principal_without_user if not trino.allow with input as imp("svc-os-ui", "dana@x.com") with data.os_grants.run_grants as grants with data.os_data as os_data with data.governance as governance

test_ui_denied_service_user_target if not trino.allow with input as imp("svc-os-ui", "svc-os-worker") with data.os_grants.run_grants as grants with data.os_data as os_data with data.governance as governance

test_ui_denied_purge_user_target if {
	not trino.allow with input as imp("svc-os-ui", "os-domain-delete")
		with data.os_grants.run_grants as grants
		with data.os_data as {"users": {"os-domain-delete": {"active": true}}}
		with data.governance as {"principals": {"os-domain-delete": {"domains": []}}}
}

# ---- nobody else ----

test_user_cannot_impersonate_user if not trino.allow with input as imp("alice@x.com", "carol@x.com") with data.os_grants.run_grants as grants with data.os_data as os_data with data.governance as governance

# Nobody keeps today's password-less dbt-runner identity as an impersonator (10 F4, WP-14).
test_legacy_dbt_runner_cannot_impersonate if not trino.allow with input as imp("dbt-runner", "sales") with data.os_grants.run_grants as grants with data.os_data as os_data with data.governance as governance

test_direct_service_user_cannot_impersonate if not trino.allow with input as imp("os-domain-delete", "alice@x.com") with data.os_grants.run_grants as grants with data.os_data as os_data with data.governance as governance

test_worker_lookalike_denied if not trino.allow with input as imp("svc-os-worker2", "alice@x.com") with data.os_grants.run_grants as grants with data.os_data as os_data with data.governance as governance

test_no_identity_denied if {
	not trino.allow with input as {"action": {"operation": "ImpersonateUser", "resource": {"user": {"user": "alice@x.com"}}}}
		with data.os_grants.run_grants as grants
		with data.os_data as os_data
}

# No grant bundle at all (WP-11 not live): every grant-bound impersonation fails closed.
test_no_grant_bundle_fails_closed if {
	not trino.allow with input as imp("svc-os-worker", "alice@x.com") with data.os_data as os_data
}

# The rules touch only ImpersonateUser: an ordinary statement is unaffected.
test_execute_query_unaffected if {
	trino.allow with input as {"context": {"identity": {"user": "alice@x.com"}}, "action": {"operation": "ExecuteQuery"}}
}

# ---- WP-14 verifier B1: no service identity is ever a target, whoever asks ----

b1_grants := {
	"g-svc-ui": {"principal_uid": "svc-os-ui", "kind": "run", "expires_at": future, "revoked": false},
	"g-svc-dg": {"principal_uid": "svc-os-worker", "kind": "standing", "active_run_id": "r9", "active_until": future, "expires_at": future},
	"g-purge": {"principal_uid": "os-domain-delete", "kind": "run", "expires_at": future},
	"g-np": {"principal_uid": "northpeak-marts", "kind": "dataset", "active_run_id": "r8", "active_until": future, "expires_at": future},
}

test_b1_worker_cannot_become_svc_os_ui_through_a_grant if not trino.allow with input as imp("svc-os-worker", "svc-os-ui") with data.os_grants.run_grants as b1_grants with data.os_data as os_data

test_b1_worker_cannot_become_purge_user_through_a_grant if not trino.allow with input as imp("svc-os-worker", "os-domain-delete") with data.os_grants.run_grants as b1_grants with data.os_data as os_data

test_b1_dagster_cannot_become_a_service_user_through_a_grant if not trino.allow with input as imp("svc-dagster-runner", "svc-os-worker") with data.os_grants.run_grants as b1_grants with data.os_data as os_data

test_b1_dagster_cannot_become_direct_user_through_a_grant if not trino.allow with input as imp("svc-dagster-runner", "northpeak-marts") with data.os_grants.run_grants as b1_grants with data.os_data as os_data

# The chain's second hop: once a session WERE svc-os-ui, it could not become admin either way,
# because the first hop is denied; and svc-os-ui itself still acts for an active admin by design.
test_b1_ui_still_acts_for_active_admin if trino.allow with input as imp("svc-os-ui", "admin") with data.os_data as {"users": {"admin": {"active": true}}}

# The reserved list is the chart's data file (os-ui core/infra/trino-service-identities.ts).
test_b1_every_listed_service_name_is_reserved if {
	every n in data.service_identities.names {
		not trino.allow with input as imp("svc-os-ui", n) with data.os_data as {"users": {n: {"active": true}}} with data.governance as {"principals": {n: {"domains": []}}}
	}
}

# Without the reserved list, nobody impersonates anyone (fail closed).
test_b1_no_reserved_list_fails_closed if not trino.allow with input as imp("svc-os-ui", "carol@x.com") with data.os_data as os_data with data.service_identities as {}

# ---- verifier note: an INACTIVE user with a leftover governance principal is refused ----

test_ui_denied_inactive_user_with_leftover_principal if not trino.allow with input as imp("svc-os-ui", "bob@x.com") with data.os_data as os_data with data.governance as {"principals": {"bob@x.com": {"domains": ["sales"], "clearances": []}}}

# ---- WP-15: the activation window (`active_until`, set by /start, cleared by /finish) ----

test_dagster_denied_after_the_activation_window if not trino.allow with input as imp("svc-dagster-runner", "wes@x.com") with data.os_grants.run_grants as grants with data.os_data as os_data with data.governance as governance

test_dagster_denied_without_an_activation_window if not trino.allow with input as imp("svc-dagster-runner", "nina@x.com") with data.os_grants.run_grants as grants with data.os_data as os_data with data.governance as governance

# ---- WP-15 verifier P1: the impersonating service users have NO data rights of their own ----
# As the SESSION user (no X-Trino-User), svc-dagster-runner and svc-os-worker may do nothing but
# ask to impersonate. Their rights are those of the principal they act for, never their own.

as_self(svc, operation, resource) := {
	"context": {"identity": {"user": svc, "groups": []}},
	"action": {"operation": operation, "resource": resource},
}

self_ops := [
	["ExecuteQuery", {}],
	["AccessCatalog", {"catalog": {"name": "iceberg"}}],
	["FilterCatalogs", {"catalog": {"name": "iceberg"}}],
	["ShowSchemas", {"catalog": {"name": "iceberg"}}],
	["FilterSchemas", {"schema": {"catalogName": "iceberg", "schemaName": "sales"}}],
	["CreateSchema", {"schema": {"catalogName": "iceberg", "schemaName": "planted"}}],
	["CreateTable", {"table": {"catalogName": "iceberg", "schemaName": "sales", "tableName": "planted"}}],
	["SelectFromColumns", {"table": {"catalogName": "iceberg", "schemaName": "ungoverned", "tableName": "t", "columns": ["a"]}}],
	["InsertIntoTable", {"table": {"catalogName": "iceberg", "schemaName": "sales", "tableName": "orders"}}],
	["DropTable", {"table": {"catalogName": "iceberg", "schemaName": "sales", "tableName": "orders"}}],
	["ShowColumns", {"table": {"catalogName": "iceberg", "schemaName": "sales", "tableName": "orders"}}],
]

test_impersonators_have_no_rights_of_their_own if {
	every svc in ["svc-dagster-runner", "svc-os-worker"] {
		every o in self_ops {
			not trino.allow with input as as_self(svc, o[0], o[1]) with data.os_grants.run_grants as grants with data.governance as governance
		}
	}
}

test_impersonator_has_no_row_access_of_its_own if {
	trino.rowFilters == {{"expression": "false"}} with input as as_self("svc-dagster-runner", "GetRowFilters", {"table": {"catalogName": "iceberg", "schemaName": "ungoverned", "tableName": "t"}})
}

# Twin: the same operations for the OWNER the runner acts for are judged as the owner (allowed
# here: an ungoverned operation for an ordinary user), and impersonation itself still works.
test_the_owner_keeps_their_rights if {
	trino.allow with input as as_self("dana@x.com", "ExecuteQuery", {}) with data.governance as governance
	trino.allow with input as imp("svc-dagster-runner", "dana@x.com") with data.os_grants.run_grants as grants with data.os_data as os_data with data.governance as governance
}
