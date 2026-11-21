# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# Who may set ANOTHER Trino session user (WP-14; design 06 §5.2 option B and §5.4, amended by
# 10 F4). Trino asks `ImpersonateUser` when the authenticated user (PASSWORD file authenticator
# on the TLS port) differs from the requested `X-Trino-User`; the OPA plugin sends the
# authenticated user in `context.identity.user` and the requested one in
# `action.resource.user.user` (https://trino.io/docs/476/security/opa-access-control.html).
# `SET SESSION AUTHORIZATION` inside an impersonated session is asked as SESSION user -> new user
# (observed on 476, tests/lakehouse/impersonation.int.test.mjs). Because no service identity can
# ever BE the session user of an impersonated session (reserved_target, for every impersonator),
# that second hop is always denied.
#
# Exactly three service users may act for someone else, each only for whom the OS says:
#   svc-os-worker      -> the principal of an active, unexpired, unrevoked `kind=run` grant
#   svc-dagster-runner -> the principal of a `kind=standing|dataset` grant while a run is active
#                         (`active_run_id` set between /start and /finish, until
#                         `active_until`); there is no
#                         schedule-principals path (10 F4)
#   svc-os-ui          -> an active OS user, interactive only (interim, removed at T7 when users
#                         reach Trino with their own Keycloak token)
# Grants come from `data.os_grants.run_grants` (the long-polled `os-grants` bundle, 10 F3) and
# users from `data.os_data.users` (the `os-data` bundle, 04 §5.2). Absent data fails closed.
# Everyone else — users, direct service users, look-alikes — may impersonate nobody.
package trino

import rego.v1

dagster_grant_kinds := {"standing", "dataset"}

# Identities that are never an impersonation target, whoever asks (WP-14 verifier B1): the `svc-`
# prefix and every service name in `data.service_identities` — the chart's data file
# policies/service_identities.json, rendered from os-ui core/infra/trino-service-identities.ts,
# the same list createUser refuses as an OS user id. `svc-` is also fixed here as a floor.
reserved_target(p) if startswith(lower(p), "svc-")

reserved_target(p) if {
	some prefix in data.service_identities.prefixes
	startswith(lower(p), prefix)
}

reserved_target(p) if lower(p) in {n | some n in data.service_identities.names}

# Without the reserved list (the data file not loaded) nobody impersonates anyone.
reserved_list_loaded if count(data.service_identities.names) > 0

is_impersonation if input.action.operation == "ImpersonateUser"

impersonation_target := input.action.resource.user.user

allow := false if {
	is_impersonation
	not impersonation_allowed
}

# The single gate every impersonator passes: the reserved list is loaded and the target is not a
# service identity. A run grant that names a service user therefore grants nothing.
impersonation_allowed if {
	reserved_list_loaded
	not reserved_target(impersonation_target)
	grant_or_user_allows
}

# A grant is live when it is not revoked and its `expires_at` (RFC 3339) is in the future. A grant
# without `expires_at` is not live: the backstop expiry is part of the grant (10 F4, ≤ 6 h).
grant_live(g) if {
	object.get(g, "revoked", false) == false
	time.parse_rfc3339_ns(g.expires_at) > time.now_ns()
}

# WP-15: /start sets `active_run_id` and `active_until` (at most 6 h ahead), /finish clears both.
# A missed /finish therefore closes itself here, with no OS process running (10 F4 backstop).
run_in_progress(g) if {
	is_string(g.active_run_id)
	g.active_run_id != ""
	time.parse_rfc3339_ns(g.active_until) > time.now_ns()
}

grant_or_user_allows if {
	user == "svc-os-worker"
	some g in data.os_grants.run_grants
	g.kind == "run"
	g.principal_uid == impersonation_target
	grant_live(g)
}

grant_or_user_allows if {
	user == "svc-dagster-runner"
	some g in data.os_grants.run_grants
	g.kind in dagster_grant_kinds
	g.principal_uid == impersonation_target
	run_in_progress(g)
	grant_live(g)
}

grant_or_user_allows if {
	user == "svc-os-ui"
	interactive_principal(impersonation_target)
}

interactive_principal(p) if data.os_data.users[p].active == true

# INTERIM until WP-35 switches every caller to the uid: the governed door still sends the session
# user os-ui chose — a uid, a domain self-principal, or a chart-declared service principal — and
# every one of them is a key of `data.governance.principals` (os-ui
# tabs/data/lib/policy/compiler.ts, chart opa.governance.principals). Bounding svc-os-ui to that
# set keeps today's queries byte-identical (tests/lakehouse/parity.int.test.mjs). WP-35 deletes
# the domain self-principals and this rule with them.
# An explicitly INACTIVE user (`os_data.users[p].active == false`) is refused even with a
# leftover principal entry (verifier note).
interactive_principal(p) if {
	data.governance.principals[p]
	not explicitly_inactive(p)
}

explicitly_inactive(p) if data.os_data.users[p].active == false

# WP-15 verifier P1: the service users that only ever act FOR someone have no rights of their
# own. As the session user (no impersonation) they may ask `ImpersonateUser` and nothing else —
# no query, no catalog or schema listing, no read, no write — and see no rows. Once Trino has
# switched the session to the principal, every check is that principal's. (svc-os-ui is not in
# this set: the query-tool still runs its own system queries until T7.)
impersonate_only := {"svc-dagster-runner", "svc-os-worker"}

allow := false if {
	user in impersonate_only
	not is_impersonation
}

rowFilters contains {"expression": "false"} if user in impersonate_only
