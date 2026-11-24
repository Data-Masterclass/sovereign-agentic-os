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
#                     "visibility": "Personal|Shared|Certified", "auth": "oauth|...", "archived": bool,
#                     "credential_mode": "per_user|shared" },   # absent on a legacy connection
#     "tool":       "<the remote server's tool name>",
#     "read_only":  bool,       # the tool only reads (server annotation readOnlyHint, or the reviewed read list)
#     "confirmed":  bool }      # the same user confirmed this exact call on the confirm card
# Output: data.os.external_mcp.decision = { "effect": "allow|requires_approval|deny", "reason": "..." }
#
# - credential_mode "per_user": every user runs on their OWN sign-in (the OS resolves the caller's
#   token and never another user's), so everyone who may USE the connection may use it.
# - credential_mode "shared": one credential for everyone in scope, chosen explicitly by a
#   domain_admin (Domain) or admin (Company); everyone who may use the connection may use it.
# - No credential_mode (a legacy connection): per-user OAuth runs on its owner's token, so only
#   its owner may use it, whatever its visibility. Anyone else is denied.
# - A connection the user may not USE is denied: their own, or a Shared/Certified one of one of
#   their domains. A Company (Certified) connection of ANOTHER domain is SEEN in os-ui (a redacted
#   view) but never USED from it — owner decision 2026-11-23 (`visible` here means usable).
#   An archived connection is denied.
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

# Each caller runs on their own sign-in.
token_owner_ok if input.connection.credential_mode == "per_user"

# One credential, shared on purpose with everyone who can see the connection.
token_owner_ok if input.connection.credential_mode == "shared"

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
