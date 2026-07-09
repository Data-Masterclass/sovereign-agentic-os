# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# Unit tests for the agent-tool authorization policy (package agentic.authz). These
# pin the fix for the query_data / retrieve deny "flip-flop": the chart seeds grants
# at `data.seed_grants` (bare keys, never PUT by os-ui) while os-ui's policy compiler
# replaces `data.grants` wholesale with PREFIXED keys (`domain:<id>` / `user:<id>`).
# `allow` unions BOTH documents, resolving the principal under bare + domain:/user:
# forms — so authorization is deterministic no matter which document holds the grant
# or which OPA (re)start order won. Default-deny for a principal absent everywhere.
package agentic.authz

import rego.v1

# The chart seed (data.json -> data.seed_grants): keyed BARE.
seed := {
	"agentic-leader-q3-2026": ["query", "metrics", "retrieve"],
	"sales-assistant": ["metrics", "retrieve"],
}

# The runtime document os-ui's policy compiler PUTs to /v1/data/grants: keyed
# PREFIXED. Note it grants query/metrics to the domain but NOT retrieve (the
# compiler's BASE_BY_ROLE lacks it) — so retrieve must come from the seed union.
runtime_grants := {
	"domain:agentic-leader-q3-2026": ["query", "metrics"],
	"user:aborek": ["query", "metrics", "promote"],
}

req(principal, tool) := {"principal": principal, "tool": tool}

# --- 1. Bare principal with a bare seed grant -> ALLOW -----------------------
# The offline/first-boot state: only the chart seed is loaded (data.grants empty).
test_bare_principal_bare_seed_allows if {
	allow with input as req("agentic-leader-q3-2026", "query")
		with data.seed_grants as seed
		with data.grants as {}
}

# --- 2. Grant only under domain: (runtime doc) -> ALLOW for a BARE lookup ----
# os-ui sends the BARE domain for query/retrieve; the compiler stored it PREFIXED.
test_bare_principal_prefixed_runtime_grant_allows if {
	allow with input as req("agentic-leader-q3-2026", "query")
		with data.grants as runtime_grants
		with data.seed_grants as {}
}

# --- 3. Prefixed user grant -> ALLOW ----------------------------------------
test_user_prefixed_grant_allows if {
	allow with input as req("aborek", "promote")
		with data.grants as runtime_grants
		with data.seed_grants as {}
}

# --- 4. THE FLIP-FLOP: runtime PUT holds ONLY prefixed keys (data.grants fully
#        replaced) and lacks `retrieve`; the seed's bare grant supplies it. Union
#        of both docs authorizes deterministically. ----------------------------
test_retrieve_survives_runtime_replace_via_seed if {
	allow with input as req("agentic-leader-q3-2026", "retrieve")
		with data.grants as runtime_grants # no retrieve here
		with data.seed_grants as seed # retrieve here (bare)
}

# --- 5. Ungranted principal -> DENY (fail-closed) ---------------------------
test_ungranted_principal_denies if {
	not allow with input as req("intruder-domain", "query")
		with data.grants as runtime_grants
		with data.seed_grants as seed
}

# --- 6. Granted principal, ungranted tool -> DENY (internet tool baseline) ---
test_granted_principal_ungranted_tool_denies if {
	not allow with input as req("agentic-leader-q3-2026", "web_fetch")
		with data.grants as runtime_grants
		with data.seed_grants as seed
}

# --- 7. Both documents empty -> DENY (nothing granted anywhere) -------------
test_empty_documents_deny if {
	not allow with input as req("agentic-leader-q3-2026", "query")
		with data.grants as {}
		with data.seed_grants as {}
}

# --- 8. requires_approval effect intact on a granted high-stakes tool -------
test_needs_approval_effect_intact if {
	e := effect with input as req("sales-assistant", "knowledge_certify")
		with data.grants as {}
		with data.seed_grants as {"sales-assistant": ["knowledge_certify"]}
		with data.requires_approval as ["knowledge_certify"]
	e == "requires_approval"
}

# --- 9. deny effect for an ungranted principal (decision surface intact) -----
test_deny_effect_intact if {
	e := effect with input as req("nobody", "query")
		with data.grants as {}
		with data.seed_grants as {}
	e == "deny"
}
