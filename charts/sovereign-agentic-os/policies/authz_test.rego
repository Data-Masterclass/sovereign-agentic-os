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

# --- 10. Bare key in the runtime document -> ALLOW ----------------------------
test_bare_runtime_grant_allows if {
	allow with input as req("sales-assistant", "metrics")
		with data.grants as {"sales-assistant": ["metrics"]}
		with data.seed_grants as {}
}

# --- 11. Prefixed keys in the seed document -> ALLOW ------------------------
test_domain_prefixed_seed_grant_allows if {
	allow with input as req("sales", "query")
		with data.grants as {}
		with data.seed_grants as {"domain:sales": ["query"]}
}

test_user_prefixed_seed_grant_allows if {
	allow with input as req("aborek", "query")
		with data.grants as {}
		with data.seed_grants as {"user:aborek": ["query"]}
}

# --- 12. The full decision object for each effect ---------------------------
test_decision_allow if {
	r := decision with input as req("sales-assistant", "metrics")
		with data.grants as {}
		with data.seed_grants as seed
		with data.requires_approval as []
	r == {"allow": true, "effect": "allow", "reason": "granted", "principal": "sales-assistant", "tool": "metrics"}
}

test_decision_requires_approval if {
	r := decision with input as req("sales-assistant", "knowledge_certify")
		with data.grants as {}
		with data.seed_grants as {"sales-assistant": ["knowledge_certify"]}
		with data.requires_approval as ["knowledge_certify"]
	r.allow == true
	r.effect == "requires_approval"
	r.reason == "high-stakes — human approval required"
}

test_decision_deny if {
	r := decision with input as req("nobody", "query")
		with data.grants as {}
		with data.seed_grants as {}
		with data.requires_approval as []
	r == {"allow": false, "effect": "deny", "reason": "not granted", "principal": "nobody", "tool": "query"}
}

# ---- WP-37: data version writes (restore / tag / branch) ----
vw(actor, ds) := {"action": "data.version.write", "actor": actor, "dataset": ds}

asset_sales := {"id": "ds_a", "tier": "asset", "owner": "maya", "domain": "sales"}

test_version_write_owner_of_personal_dataset if {
	data_version_write with input as vw({"id": "lena", "role": "creator", "domains": ["sales"]}, {"id": "ds_p", "tier": "dataset", "owner": "lena", "domain": "sales"})
}

test_version_write_personal_is_owner_only if {
	# negative twin: not even an admin or the domain's admin restores someone's personal lane
	not data_version_write with input as vw({"id": "boss", "role": "admin", "domains": ["sales"]}, {"id": "ds_p", "tier": "dataset", "owner": "lena", "domain": "sales"})
	not data_version_write with input as vw({"id": "dina", "role": "domain_admin", "domains": ["sales"]}, {"id": "ds_p", "tier": "dataset", "owner": "lena", "domain": "sales"})
}

test_version_write_domain_admin_of_domain_allowed if {
	data_version_write with input as vw({"id": "dina", "role": "domain_admin", "domains": ["sales"]}, asset_sales)
	data_version_write with input as vw({"id": "dina", "role": "domain_admin", "domains": ["sales"]}, object.union(asset_sales, {"tier": "product"}))
}

test_version_write_admin_allowed if {
	data_version_write with input as vw({"id": "boss", "role": "admin", "domains": []}, asset_sales)
}

test_version_write_builder_refused if {
	# negative twin: a builder of the domain, even the dataset's owner, only files a request
	not data_version_write with input as vw({"id": "maya", "role": "builder", "domains": ["sales"]}, asset_sales)
	not data_version_write with input as vw({"id": "lena", "role": "creator", "domains": ["sales"]}, asset_sales)
}

test_version_write_other_domain_admin_refused if {
	not data_version_write with input as vw({"id": "fred", "role": "domain_admin", "domains": ["finance"]}, asset_sales)
}

test_version_write_other_action_refused if {
	not data_version_write with input as {"action": "data.read", "actor": {"id": "boss", "role": "admin", "domains": []}, "dataset": asset_sales}
}

# ---- workflow writes (author / index / publish / retire a workflow, wf_...) ----
# The rule decides on the caller's role and domains and the workflow's tier, owner and domain.
# A workflow is NOT a knowledge note: notes have no rule here.
ww(op, actor, wf) := {"action": "workflow.write", "op": op, "actor": actor, "workflow": wf}

cara := {"id": "cara", "role": "creator", "domains": ["sales"]}

ben := {"id": "ben", "role": "builder", "domains": ["sales"]}

dana := {"id": "dana", "role": "domain_admin", "domains": ["sales"]}

ada := {"id": "ada", "role": "admin", "domains": []}

finn := {"id": "finn", "role": "creator", "domains": ["finance"]}

fred_admin := {"id": "fina", "role": "domain_admin", "domains": ["finance"]}

wf_mine := {"id": "wf_1", "tier": "personal", "owner": "cara", "domain": "sales"}

wf_shared := {"id": "wf_2", "tier": "shared", "owner": "maya", "domain": "sales"}

wf_company := {"id": "wf_3", "tier": "certified", "owner": "maya", "domain": "sales"}

test_workflow_create_owner_in_own_domain_allowed if {
	workflow_write with input as ww("create", cara, wf_mine)
	workflow_write with input as ww("create", ada, {"id": "", "tier": "personal", "owner": "ada", "domain": "sales"})
}

test_workflow_create_outside_domain_or_for_someone_else_refused if {
	# negative twins: a domain the caller is not in; a workflow owned by another user
	not workflow_write with input as ww("create", finn, wf_mine)
	not workflow_write with input as ww("create", cara, {"id": "", "tier": "personal", "owner": "maya", "domain": "sales"})
}

test_workflow_index_owner_builder_and_domain_member_allowed if {
	workflow_write with input as ww("index", cara, wf_mine)
	workflow_write with input as ww("index", ben, wf_mine)
	workflow_write with input as ww("index", cara, wf_shared)
	workflow_write with input as ww("index", ada, wf_company)
}

test_workflow_index_refused_for_outsiders_and_peers_of_a_personal_draft if {
	not workflow_write with input as ww("index", finn, wf_mine)
	not workflow_write with input as ww("index", finn, wf_shared)

	# a creator who is not the owner does not index another creator's private draft
	not workflow_write with input as ww("index", {"id": "cory", "role": "creator", "domains": ["sales"]}, wf_mine)
}

test_workflow_publish_domain_admin_of_domain_or_admin_only if {
	workflow_write with input as ww("publish", dana, wf_mine)
	workflow_write with input as ww("publish", ada, wf_mine)
}

test_workflow_publish_refused_for_creator_builder_and_other_domain if {
	# negative twins: the owner who is only a creator publishes nothing to Domain; nor a builder
	not workflow_write with input as ww("publish", cara, wf_mine)
	not workflow_write with input as ww("publish", ben, wf_mine)

	# a domain admin of ANOTHER domain, and a user outside the domain
	not workflow_write with input as ww("publish", fred_admin, wf_mine)
	not workflow_write with input as ww("publish", finn, wf_mine)
}

test_workflow_retire_owner_and_domain_builder_allowed if {
	workflow_write with input as ww("retire", cara, wf_mine)
	workflow_write with input as ww("retire", ben, wf_shared)
	workflow_write with input as ww("retire", ada, wf_company)
}

test_workflow_retire_refused_for_peers_outsiders_and_non_admin_company if {
	not workflow_write with input as ww("retire", ben, wf_mine)
	not workflow_write with input as ww("retire", ada, wf_mine)
	not workflow_write with input as ww("retire", finn, wf_shared)
	not workflow_write with input as ww("retire", cara, wf_shared)
	not workflow_write with input as ww("retire", dana, wf_company)
}

test_workflow_write_unknown_op_or_action_refused if {
	not workflow_write with input as ww("delete-everything", ada, wf_mine)
	not workflow_write with input as object.union(ww("create", cara, wf_mine), {"action": "data.version.write"})
	not workflow_write with input as {}
}

test_workflow_update_owner_and_domain_builder_on_shared if {
	workflow_write with input as ww("update", cara, wf_mine)
	workflow_write with input as ww("update", ben, wf_shared)
	workflow_write with input as ww("update", ada, wf_company)
}

test_workflow_update_refused_for_peers_outsiders_and_a_builder_on_a_private_draft if {
	not workflow_write with input as ww("update", ben, wf_mine)
	not workflow_write with input as ww("update", ada, wf_mine)
	not workflow_write with input as ww("update", finn, wf_shared)
	not workflow_write with input as ww("update", cara, wf_shared)
}

test_workflow_certify_is_admin_only if {
	workflow_write with input as ww("certify", ada, wf_shared)
	not workflow_write with input as ww("certify", dana, wf_shared)
	not workflow_write with input as ww("certify", cara, wf_shared)
	not workflow_write with input as ww("certify", finn, wf_shared)
}
