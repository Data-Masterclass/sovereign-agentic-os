# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# External MCP tools in the chat (package os.external_mcp). One decision per call the Home chat
# makes on a remote MCP server of one of the user's Connections (for example Notion's hosted MCP).
# The chat asks OPA before every such call; a failure to get an answer is a refusal.
#
# Input:
#   { "user":       { "id": "<user id>", "domains": ["<domain>", ...] },
#     "connection": { "id": "<connection id>", "owner": "<user id>", "domain": "<domain>",
#                     "visibility": "Personal|Shared|Certified", "auth": "oauth|...", "archived": bool },
#     "tool":       "<the remote server's tool name>",
#     "read_only":  bool,       # the tool only reads (server annotation readOnlyHint, or the reviewed read list)
#     "confirmed":  bool }      # the same user confirmed this exact call on the confirm card
# Output: data.os.external_mcp.decision = { "effect": "allow|requires_approval|deny", "reason": "..." }
#
# - A connection with per-user OAuth runs on its owner's token, so only its owner may use it,
#   whatever its visibility. Anyone else is denied.
# - A connection that is not visible to the user is denied. An archived connection is denied.
# - A tool that only reads is allowed. Every other tool (create, update, delete, anything the
#   server did not mark as read-only) needs the user's confirmation: requires_approval until the
#   call is confirmed, then allow.

package os.external_mcp

import rego.v1

default decision := {"effect": "deny", "reason": "no_decision"}

visible if input.connection.owner == input.user.id

visible if {
	input.connection.visibility in {"Shared", "Certified"}
	input.connection.domain in input.user.domains
}

visible if {
	input.connection.visibility in {"Shared", "Certified"}
	not input.connection.domain
}

# OAuth tokens belong to the person who connected; nobody else may run on them.
token_owner_ok if input.connection.auth != "oauth"

token_owner_ok if input.connection.owner == input.user.id

deny_reason := "connection_not_visible" if not visible

deny_reason := "archived" if {
	visible
	input.connection.archived == true
}

deny_reason := "token_belongs_to_owner" if {
	visible
	not input.connection.archived == true
	not token_owner_ok
}

decision := {"effect": "deny", "reason": deny_reason}

decision := {"effect": "allow", "reason": "read"} if {
	not deny_reason
	input.read_only == true
}

decision := {"effect": "allow", "reason": "confirmed"} if {
	not deny_reason
	not input.read_only == true
	input.confirmed == true
}

decision := {"effect": "requires_approval", "reason": "write_needs_confirmation"} if {
	not deny_reason
	not input.read_only == true
	not input.confirmed == true
}
