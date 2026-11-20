# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# Agent-tool authorization (package agentic.authz): default-deny at the MCP/tool
# boundary. The chart loads this file (templates/base/opa/opa.yaml); its unit
# tests sit beside it in authz_test.rego.
package agentic.authz

import rego.v1

# Default-deny at the tool boundary (least privilege).
default allow := false

# A principal may use a tool only if it has been granted that tool.
# Internet tools (e.g. web_fetch) are absent from grants -> denied.
#
# Grants live in TWO documents that must both authorize, deterministically:
#  - data.seed_grants — the chart-baked defaults (data.json), keyed BARE
#    (e.g. "agentic-leader-q3-2026"). OWNED by the chart; os-ui never PUTs it,
#    so an OPA (re)start / file re-read always restores it (no flip-flop).
#  - data.grants — the runtime document Platform Admin's policy compiler
#    replaces wholesale via `PUT /v1/data/grants`, keyed PREFIXED
#    ("domain:<id>" / "user:<id>"). A full PUT here can never clobber the
#    seed, because the seed lives at a DISTINCT path.
# os-ui authorizes with a BARE principal on some paths (domain query/retrieve)
# and a PREFIXED one on others (user:<id> admin), and either document may hold
# either key form — so we resolve the principal under ALL forms in BOTH docs
# and allow if ANY of them grants the tool. Union of grants; still default-deny
# for a principal absent from every form in both docs.
granted_tools contains tool if some tool in data.grants[input.principal]
granted_tools contains tool if some tool in data.grants[sprintf("domain:%s", [input.principal])]
granted_tools contains tool if some tool in data.grants[sprintf("user:%s", [input.principal])]
granted_tools contains tool if some tool in data.seed_grants[input.principal]
granted_tools contains tool if some tool in data.seed_grants[sprintf("domain:%s", [input.principal])]
granted_tools contains tool if some tool in data.seed_grants[sprintf("user:%s", [input.principal])]

allow if {
	some tool in granted_tools
	tool == input.tool
}

# High-stakes tools (external connection writes, certify/publish) are paused
# for human approval even when granted (Agent golden path §7). The list lives
# in data.requires_approval (set by opa.requiresApproval in values).
needs_approval if {
	some tool in data.requires_approval
	tool == input.tool
}

# Rich effect: deny (not granted) / requires_approval (granted + high-stakes)
# / allow (granted + low-stakes). The legacy boolean `allow` above is kept so
# the Governance grants matrix keeps working unchanged.
effect := "deny" if not allow

effect := "requires_approval" if {
	allow
	needs_approval
}

effect := "allow" if {
	allow
	not needs_approval
}

reason := "not granted" if not allow

reason := "high-stakes — human approval required" if {
	allow
	needs_approval
}

reason := "granted" if {
	allow
	not needs_approval
}

decision := {
	"allow": allow,
	"effect": effect,
	"reason": reason,
	"principal": input.principal,
	"tool": input.tool,
}

# WP-37: a WRITE to a dataset's data versions (restore = rollback_to_snapshot, name = an Iceberg tag
# or branch). The same ladder as My -> Domain promotion: a personal (My) dataset only by its owner;
# a Domain (asset) or Company (product) dataset only by a domain_admin of its domain, or an admin.
# A builder may file a request but never restores a governed table. os-ui asks this rule before the
# write reaches Trino or the catalog (os-ui/tabs/data/lib/dataset-versions.ts).
# Input: {"action": "data.version.write", "actor": {"id", "role", "domains"},
#         "dataset": {"id", "tier": "dataset"|"asset"|"product", "owner", "domain"}}
default data_version_write := false

data_version_write if {
	input.action == "data.version.write"
	input.dataset.tier == "dataset"
	input.actor.id == input.dataset.owner
}

data_version_write if {
	input.action == "data.version.write"
	input.dataset.tier in {"asset", "product"}
	input.actor.role == "admin"
}

data_version_write if {
	input.action == "data.version.write"
	input.dataset.tier in {"asset", "product"}
	input.actor.role == "domain_admin"
	input.dataset.domain in input.actor.domains
}
