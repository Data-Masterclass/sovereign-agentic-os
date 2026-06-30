# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# Connections -> OPA capability policy. The STATIC generic policy logic; the
# per-connection/grant DATA is COMPILED by os-ui/lib/capability-compiler.ts and
# published as an OPA data bundle under `data.connections[<principal>]`:
#
#   data.connections[principal] = {
#     "tools":  { "<tool>": { "mode": "Read|Write-approval|Write-bounded|Off|Blocked",
#                             "write": bool, "maxAmount": number } },
#     "grants": { "<agentPrincipal>": ["<tool>", ...] }   # restrict-only
#   }
#
# This Rego mirrors `decide()` in capability-compiler.ts EXACTLY, so the offline
# mirror (lib/agent-governed.ts) and this live policy cannot drift — author the
# capability profile once in the UI, enforce it the same way everywhere.
#
# Input: { "principal": <connPrincipal>, "tool": <name>, "args": {"amount": n},
#          "asAgent": <agentPrincipal?> }
# Output (data.connections.authz.decision): { "effect": "...", "reason": "..." }

package connections.authz

import rego.v1

# Default-deny: no matching connection/tool rule.
default decision := {"effect": "deny", "reason": "no matching connection rule"}

rule := data.connections[input.principal].tools[input.tool]

# Restrict-only grant: if an asAgent grant exists, the tool must be in it.
grant_ok if not input.asAgent
grant_ok if not data.connections[input.principal].grants[input.asAgent]
grant_ok if {
	input.asAgent
	input.tool in data.connections[input.principal].grants[input.asAgent]
}

decision := {"effect": "deny", "reason": "grant excludes tool"} if {
	rule
	not grant_ok
}

decision := {"effect": "deny", "reason": "Off — not exposed"} if {
	grant_ok
	rule.mode == "Off"
}

decision := {"effect": "deny", "reason": "Blocked — needs Admin override"} if {
	grant_ok
	rule.mode == "Blocked"
}

decision := {"effect": "allow", "reason": "read"} if {
	grant_ok
	rule.mode == "Read"
}

decision := {"effect": "requires_approval", "reason": "write held for approval"} if {
	grant_ok
	rule.mode == "Write-approval"
}

decision := {"effect": "allow", "reason": "within bound"} if {
	grant_ok
	rule.mode == "Write-bounded"
	to_number(input.args.amount) <= rule.maxAmount
}

decision := {"effect": "deny", "reason": "amount exceeds bound"} if {
	grant_ok
	rule.mode == "Write-bounded"
	to_number(input.args.amount) > rule.maxAmount
}
