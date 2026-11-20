# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# Unit tests for the connection capability policy (package connections.authz):
# every capability mode, the bounded-write limit, the restrict-only agent grant and
# default-deny. The data shape is the one documented at the top of connections.rego.
package connections.authz_test

import rego.v1

import data.connections.authz

# Mocked at data.connections.crm (not the whole data.connections tree, which also
# holds this policy package).
crm := {
	"tools": {
		"list_accounts": {"mode": "Read", "write": false},
		"update_account": {"mode": "Write-approval", "write": true},
		"refund": {"mode": "Write-bounded", "write": true, "maxAmount": 100},
		"export_all": {"mode": "Off", "write": false},
		"delete_account": {"mode": "Blocked", "write": true},
	},
	"grants": {"agent-sales": ["list_accounts", "refund"]},
}

test_read_allows if {
	r := authz.decision with input as {"principal": "crm", "tool": "list_accounts"}
		with data.connections.crm as crm
	r == {"effect": "allow", "reason": "read"}
}

test_write_approval_is_held if {
	r := authz.decision with input as {"principal": "crm", "tool": "update_account"}
		with data.connections.crm as crm
	r == {"effect": "requires_approval", "reason": "write held for approval"}
}

test_off_denies if {
	r := authz.decision with input as {"principal": "crm", "tool": "export_all"}
		with data.connections.crm as crm
	r.effect == "deny"
}

test_blocked_denies if {
	r := authz.decision with input as {"principal": "crm", "tool": "delete_account"}
		with data.connections.crm as crm
	r == {"effect": "deny", "reason": "Blocked — needs Admin override"}
}

test_bounded_write_within_limit_allows if {
	r := authz.decision with input as {"principal": "crm", "tool": "refund", "args": {"amount": 100}}
		with data.connections.crm as crm
	r == {"effect": "allow", "reason": "within bound"}
}

test_bounded_write_over_limit_denies if {
	r := authz.decision with input as {"principal": "crm", "tool": "refund", "args": {"amount": "101"}}
		with data.connections.crm as crm
	r == {"effect": "deny", "reason": "amount exceeds bound"}
}

test_unknown_tool_default_denies if {
	r := authz.decision with input as {"principal": "crm", "tool": "drop_tables"}
		with data.connections.crm as crm
	r == {"effect": "deny", "reason": "no matching connection rule"}
}

test_unknown_connection_default_denies if {
	r := authz.decision with input as {"principal": "nope", "tool": "list_accounts"}
		with data.connections.crm as crm
	r.effect == "deny"
}

test_agent_grant_includes_tool_allows if {
	r := authz.decision with input as {"principal": "crm", "tool": "list_accounts", "asAgent": "agent-sales"}
		with data.connections.crm as crm
	r.effect == "allow"
}

test_agent_grant_restricts_tool if {
	r := authz.decision with input as {"principal": "crm", "tool": "update_account", "asAgent": "agent-sales"}
		with data.connections.crm as crm
	r == {"effect": "deny", "reason": "grant excludes tool"}
}

test_agent_without_grant_falls_back_to_profile if {
	r := authz.decision with input as {"principal": "crm", "tool": "update_account", "asAgent": "agent-other"}
		with data.connections.crm as crm
	r.effect == "requires_approval"
}
