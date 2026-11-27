# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# Unit tests for app_identity.rego (App Builder workstream E): own consent only, and an app token only for the
# user's own identity with the scopes an app may carry.
package agentic.authz

import rego.v1

ai_cara := {"id": "cara", "role": "creator", "domains": ["sales"]}

ai_ada := {"id": "ada", "role": "admin", "domains": []}

acw(action, actor, user, env) := {"action": action, "actor": actor, "target": {"user": user, "app": "sales/orders", "env": env}}

ati(actor, user, scope) := {"action": "app.token.issue", "actor": actor, "target": {"user": user, "app": "sales/orders", "env": "dev", "scope": scope}}

test_app_consent_write_own_record if {
	app_consent_write with input as acw("app.consent.grant", ai_cara, "cara", "dev")
	app_consent_write with input as acw("app.consent.revoke", ai_cara, "cara", "prod")
}

test_app_consent_write_refused_for_someone_else if {
	not app_consent_write with input as acw("app.consent.grant", ai_cara, "maya", "dev")
	not app_consent_write with input as acw("app.consent.grant", ai_ada, "cara", "dev")
	not app_consent_write with input as acw("app.consent.grant", ai_cara, "cara", "staging")
	not app_consent_write with input as acw("user.pref.write", ai_cara, "cara", "dev")
	not app_consent_write with input as acw("app.consent.grant", {"id": "", "role": "creator", "domains": []}, "", "dev")
}

test_app_token_issue_own_token_known_scopes if {
	app_token_issue with input as ati(ai_cara, "cara", ["read"])
	app_token_issue with input as ati(ai_cara, "cara", ["action:add_order", "agent-run", "read"])
}

test_app_token_issue_refuses_forbidden_scopes_and_other_users if {
	not app_token_issue with input as ati(ai_cara, "cara", ["read", "approval-decide"])
	not app_token_issue with input as ati(ai_cara, "cara", ["read", "admin"])
	not app_token_issue with input as ati(ai_cara, "cara", ["read", "governed-write"])
	not app_token_issue with input as ati(ai_cara, "cara", ["read", "action:Bad Name"])
	not app_token_issue with input as ati(ai_cara, "cara", [])
	not app_token_issue with input as ati(ai_cara, "maya", ["read"])
	not app_token_issue with input as object.union(ati(ai_cara, "cara", ["read"]), {"action": "app.consent.grant"})
}
