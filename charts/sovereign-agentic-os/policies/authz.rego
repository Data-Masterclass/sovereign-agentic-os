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

# A WRITE to a workflow (wf_..., the documentation of a business process; a knowledge note has no rule
# here): author (create), edit (update), index, publish, certify, retire. os-ui asks this rule before the store is touched
# (os-ui/tabs/knowledge/mcp/knowledge-write-tools.ts) and never fails open: an OPA that does not
# answer denies. The store's own gates stay the inner authority; this is the door in front of them.
#   create  the owner, in a domain they belong to (an admin spans the tenant)
#   index   the owner; a builder or better of the workflow's domain; for a Domain/Company workflow
#           any member of its domain; an admin
#   publish a domain_admin of the workflow's domain, or an admin (My -> Domain is their approval)
#   retire / update  the owner; a builder or better of the domain for a Domain workflow; an admin for a
#           Domain or Company one (update = edit, rename, move, tacit, links, restore a version, unarchive)
#   certify an admin (Domain -> Company)
# Input: {"action": "workflow.write", "op": "create"|"update"|"index"|"publish"|"certify"|"retire",
#         "actor": {"id", "role", "domains"},
#         "workflow": {"id", "tier": "personal"|"shared"|"certified", "owner", "domain"}}
default workflow_write := false

builder_up := {"builder", "domain_admin", "admin"}

workflow_write if {
	input.action == "workflow.write"
	input.op == "create"
	input.workflow.owner == input.actor.id
	workflow_domain_member
}

workflow_write if {
	input.action == "workflow.write"
	input.op == "create"
	input.workflow.owner == input.actor.id
	input.actor.role == "admin"
}

workflow_write if {
	input.action == "workflow.write"
	input.op == "index"
	input.workflow.owner == input.actor.id
}

workflow_write if {
	input.action == "workflow.write"
	input.op == "index"
	input.actor.role in builder_up
	workflow_domain_member
}

workflow_write if {
	input.action == "workflow.write"
	input.op == "index"
	input.workflow.tier in {"shared", "certified"}
	workflow_domain_member
}

workflow_write if {
	input.action == "workflow.write"
	input.op == "index"
	input.workflow.tier in {"shared", "certified"}
	input.actor.role == "admin"
}

workflow_write if {
	input.action == "workflow.write"
	input.op == "publish"
	input.actor.role == "domain_admin"
	workflow_domain_member
}

workflow_write if {
	input.action == "workflow.write"
	input.op == "publish"
	input.actor.role == "admin"
}

workflow_write if {
	input.action == "workflow.write"
	input.op in {"retire", "update"}
	input.workflow.owner == input.actor.id
}

workflow_write if {
	input.action == "workflow.write"
	input.op in {"retire", "update"}
	input.workflow.tier == "shared"
	input.actor.role in builder_up
	workflow_domain_member
}

workflow_write if {
	input.action == "workflow.write"
	input.op in {"retire", "update"}
	input.workflow.tier in {"shared", "certified"}
	input.actor.role == "admin"
}

workflow_domain_member if input.workflow.domain in input.actor.domains

workflow_write if {
	input.action == "workflow.write"
	input.op == "certify"
	input.actor.role == "admin"
}

# A CREATE by an upload door: the Files upload, the Data "New dataset", the Knowledge personal note,
# and the chat attachment door (POST /api/assistant/attachments). The new item is ALWAYS private:
# tier personal (My scope), owned by the caller, in a domain the caller belongs to; an admin spans
# the tenant. Promotion out of My scope is a separate, gated act (never through this rule). os-ui asks
# before the store is touched and never fails open: an OPA that does not answer denies.
# Input: {"action": "upload.create", "kind": "file"|"dataset"|"knowledge",
#         "actor": {"id", "role", "domains"}, "target": {"tier": "personal", "owner", "domain"}}
default upload_create := false

upload_create_kinds := {"file", "dataset", "knowledge"}

upload_create if {
	upload_create_own_private
	input.target.domain in input.actor.domains
}

upload_create if {
	upload_create_own_private
	input.actor.role == "admin"
}

upload_create_own_private if {
	input.action == "upload.create"
	input.kind in upload_create_kinds
	input.target.tier == "personal"
	input.target.owner == input.actor.id
}
