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
