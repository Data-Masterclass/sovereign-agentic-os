# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# Unit tests for os.external_mcp: every effect, each with its negative twin.
package os.external_mcp_test

import rego.v1

import data.os.external_mcp

alice := {"id": "alice", "domains": ["sales"]}

bob := {"id": "bob", "domains": ["sales"]}

carol := {"id": "carol", "domains": ["hr"]}

conn := {"id": "conn_1", "owner": "alice", "domain": "sales", "visibility": "Personal", "auth": "oauth", "archived": false}

test_read_by_owner_allows if {
	external_mcp.decision == {"effect": "allow", "reason": "read"} with input as {"user": alice, "connection": conn, "tool": "notion-search", "read_only": true}
}

test_write_by_owner_parks if {
	external_mcp.decision == {"effect": "requires_approval", "reason": "write_needs_confirmation"} with input as {"user": alice, "connection": conn, "tool": "notion-create-pages", "read_only": false}
}

test_tool_without_read_only_flag_is_a_write if {
	external_mcp.decision.effect == "requires_approval" with input as {"user": alice, "connection": conn, "tool": "x"}
}

test_confirmed_write_allows if {
	external_mcp.decision == {"effect": "allow", "reason": "confirmed"} with input as {"user": alice, "connection": conn, "tool": "notion-create-pages", "read_only": false, "confirmed": true}
}

test_confirmed_does_not_widen_to_another_user if {
	external_mcp.decision.effect == "deny" with input as {"user": bob, "connection": conn, "tool": "notion-create-pages", "read_only": false, "confirmed": true}
}

test_other_user_cannot_read_personal_connection if {
	external_mcp.decision == {"effect": "deny", "reason": "connection_not_visible"} with input as {"user": bob, "connection": conn, "tool": "notion-search", "read_only": true}
}

test_shared_oauth_connection_is_owner_only if {
	shared := object.union(conn, {"visibility": "Shared"})
	external_mcp.decision == {"effect": "deny", "reason": "token_belongs_to_owner"} with input as {"user": bob, "connection": shared, "tool": "notion-search", "read_only": true}
}

test_shared_oauth_connection_owner_still_allowed if {
	shared := object.union(conn, {"visibility": "Shared"})
	external_mcp.decision.effect == "allow" with input as {"user": alice, "connection": shared, "tool": "notion-search", "read_only": true}
}

test_shared_non_oauth_connection_visible_in_domain if {
	shared := object.union(conn, {"visibility": "Shared", "auth": "token"})
	external_mcp.decision.effect == "allow" with input as {"user": bob, "connection": shared, "tool": "t", "read_only": true}
}

test_shared_non_oauth_connection_hidden_from_other_domain if {
	shared := object.union(conn, {"visibility": "Shared", "auth": "token"})
	external_mcp.decision.reason == "connection_not_visible" with input as {"user": carol, "connection": shared, "tool": "t", "read_only": true}
}

# SEE, NOT USE (owner decision 2026-11-23): a Company (Certified) connection is SEEN by every
# domain in os-ui (a redacted view), but only its OWN domain may USE it — this rule is about use.
test_certified_connection_not_usable_from_another_domain if {
	company := object.union(conn, {"visibility": "Certified", "auth": "token"})
	external_mcp.decision == {"effect": "deny", "reason": "connection_not_visible"} with input as {"user": carol, "connection": company, "tool": "t", "read_only": true}
}

test_certified_connection_usable_in_its_own_domain if {
	company := object.union(conn, {"visibility": "Certified", "auth": "token"})
	external_mcp.decision.effect == "allow" with input as {"user": bob, "connection": company, "tool": "t", "read_only": true}
}

test_domainless_shared_connection_is_visible if {
	shared := {"id": "c", "owner": "alice", "visibility": "Shared", "auth": "token", "archived": false}
	external_mcp.decision.effect == "allow" with input as {"user": carol, "connection": shared, "tool": "t", "read_only": true}
}

test_archived_connection_is_denied if {
	archived := object.union(conn, {"archived": true})
	external_mcp.decision == {"effect": "deny", "reason": "archived"} with input as {"user": alice, "connection": archived, "tool": "notion-search", "read_only": true}
}

test_empty_input_is_denied if {
	external_mcp.decision.effect == "deny" with input as {}
}
