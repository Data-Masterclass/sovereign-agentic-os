# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# Who may set ANOTHER Trino session user (WP-14; design 06 §5.2 option B and §5.4, amended by
# 10 F4). Trino asks `ImpersonateUser` when the authenticated user (PASSWORD file authenticator
# on the TLS port) differs from the requested `X-Trino-User`; the OPA plugin sends the
# authenticated user in `context.identity.user` and the requested one in
# `action.resource.user.user` (https://trino.io/docs/476/security/opa-access-control.html).
# `SET SESSION AUTHORIZATION` inside an impersonated session is asked as SESSION user -> new user
# (observed on 476, tests/lakehouse/impersonation.int.test.mjs), so it is always denied below:
# the session user is never one of the three service users.
#
# Exactly three service users may act for someone else, each only for whom the OS says:
#   svc-os-worker      -> the principal of an active, unexpired, unrevoked `kind=run` grant
#   svc-dagster-runner -> the principal of a `kind=standing|dataset` grant while a run is active
#                         (`active_run_id` set between /start and /finish); there is no
#                         schedule-principals path (10 F4)
#   svc-os-ui          -> an active OS user, interactive only (interim, removed at T7 when users
#                         reach Trino with their own Keycloak token)
# Grants come from `data.os_grants.run_grants` (the long-polled `os-grants` bundle, 10 F3) and
# users from `data.os_data.users` (the `os-data` bundle, 04 §5.2). Absent data fails closed.
# Everyone else — users, direct service users, look-alikes — may impersonate nobody.
package trino

import rego.v1

dagster_grant_kinds := {"standing", "dataset"}

# Identities that are never an impersonation target: the service users themselves and the direct
# service users that log in with their own password (the delete-domain purge user).
reserved_target(p) if startswith(p, "svc-")

reserved_target("os-domain-delete")

is_impersonation if input.action.operation == "ImpersonateUser"

impersonation_target := input.action.resource.user.user

allow := false if {
	is_impersonation
	not impersonation_allowed
}

# A grant is live when it is not revoked and its `expires_at` (RFC 3339) is in the future. A grant
# without `expires_at` is not live: the backstop expiry is part of the grant (10 F4, ≤ 6 h).
grant_live(g) if {
	object.get(g, "revoked", false) == false
	time.parse_rfc3339_ns(g.expires_at) > time.now_ns()
}

run_in_progress(g) if {
	is_string(g.active_run_id)
	g.active_run_id != ""
}

impersonation_allowed if {
	user == "svc-os-worker"
	some g in data.os_grants.run_grants
	g.kind == "run"
	g.principal_uid == impersonation_target
	grant_live(g)
}

impersonation_allowed if {
	user == "svc-dagster-runner"
	some g in data.os_grants.run_grants
	g.kind in dagster_grant_kinds
	g.principal_uid == impersonation_target
	run_in_progress(g)
	grant_live(g)
}

impersonation_allowed if {
	user == "svc-os-ui"
	not reserved_target(impersonation_target)
	interactive_principal(impersonation_target)
}

interactive_principal(p) if data.os_data.users[p].active == true

# INTERIM until WP-35 switches every caller to the uid: the governed door still sends the session
# user os-ui chose — a uid, a domain self-principal, or a chart-declared service principal — and
# every one of them is a key of `data.governance.principals` (os-ui
# tabs/data/lib/policy/compiler.ts, chart opa.governance.principals). Bounding svc-os-ui to that
# set keeps today's queries byte-identical (tests/lakehouse/parity.int.test.mjs). WP-35 deletes
# the domain self-principals and this rule with them.
interactive_principal(p) if data.governance.principals[p]
