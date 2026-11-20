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
	"g-standing-active": {"principal_uid": "dana@x.com", "kind": "standing", "active_run_id": "run-1", "expires_at": future},
	"g-dataset-active": {"principal_uid": "dave@x.com", "kind": "dataset", "active_run_id": "run-2", "expires_at": future},
	"g-standing-idle": {"principal_uid": "ida@x.com", "kind": "standing", "active_run_id": null, "expires_at": future},
	"g-standing-empty-run": {"principal_uid": "eve@x.com", "kind": "standing", "active_run_id": "", "expires_at": future},
	"g-standing-expired": {"principal_uid": "sam@x.com", "kind": "standing", "active_run_id": "run-3", "expires_at": past},
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
