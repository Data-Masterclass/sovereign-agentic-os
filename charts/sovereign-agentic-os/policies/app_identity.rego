# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# App Builder (workstream E, spec section 8): the user's OWN consent for an app built in the OS to act as them, and
# the app identity token minted from it (package agentic.authz, same as authz.rego). Loaded by OPA ONLY while the
# App Builder is enabled (`softwareRunner.environments.enabled`, templates/base/opa/_policy-files.tpl), so with the
# switch off the OPA policy and its revision are exactly what they were. os-ui asks before the consent store is
# touched or a token is minted (os-ui/core/auth/app-login.ts) and never fails open: an OPA that does not answer, or
# that has not loaded this file, denies. Unit tests beside it in app_identity_test.rego.
package agentic.authz

import rego.v1

app_envs := {"dev", "prod"}

# Input: {"action": "app.consent.grant"|"app.consent.revoke", "actor": {"id", "role", "domains"},
#         "target": {"user", "app", "env"}}
default app_consent_write := false

app_consent_actions := {"app.consent.grant", "app.consent.revoke"}

app_consent_write if {
	input.action in app_consent_actions
	input.actor.id != ""
	input.target.user == input.actor.id
	input.target.env in app_envs
}

# The token carries only the user's own identity, for scopes an app may have: `read`, `agent-run` and one
# `action:<name>` per declared write action. Never an approval, admin or generic governed-write scope.
# Input: {"action": "app.token.issue", "actor": {...}, "target": {"user", "app", "env", "scope": [..]}}
default app_token_issue := false

app_token_issue if {
	input.action == "app.token.issue"
	input.actor.id != ""
	input.target.user == input.actor.id
	input.target.env in app_envs
	count(input.target.scope) > 0
	every s in input.target.scope {
		app_token_scope_shape(s)
	}
}

app_token_scope_shape("read")

app_token_scope_shape("agent-run")

app_token_scope_shape(s) if regex.match(`^action:[a-z][a-z0-9_]{0,63}$`, s)
