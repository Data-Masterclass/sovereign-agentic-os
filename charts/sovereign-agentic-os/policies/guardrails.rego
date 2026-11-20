# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# Knowledge workflow guardrails (design 04 M7, design 11 A24, WP-30). ONE platform policy for
# every workflow: no per-workflow Rego text. It reads the guardrail DATA each domain commits to
# git (`knowledge/workflows/<slug>/guardrails.json`, written by os-ui's knowledge bundle):
#
#   { "guardrails": [ { "id": "wr2", "level": "workflow|step", "step_id": "verify", "text": "..." } ] }
#
# os-ui places each committed file at data.os_data.guardrails[<workflow id>] in the os-data OPA
# bundle (opa.dataBundle + opa.guardrailsData). Outside the OS the same files load with
# OPA's own prefix syntax (the eject):
#
#   opa eval -d guardrails.rego \
#     -d 'os_data.guardrails.<workflow id>:knowledge/workflows/<slug>/guardrails.json' \
#     -i call.json 'data.os.guardrails.decision'
#
# Input:  { "workflow_id": "<id>", "violations": ["<guardrail id>", ...] }
# Output: data.os.guardrails.decision = { "allow", "reason", "violated", "guardrails" }
#
# A call is allowed only when the workflow's committed guardrails are loaded and the call
# violates none of them. A workflow with no committed guardrails is NOT allowed by default:
# an unknown workflow id is indistinguishable from data that did not load (fail closed).

package os.guardrails

import rego.v1

# The committed guardrail list of the workflow named in the call.
workflow_guardrails := data.os_data.guardrails[input.workflow_id].guardrails

# The guardrail ids of that workflow.
ids contains g.id if some g in workflow_guardrails

# The guardrail ids the call reports as violated, restricted to this workflow's guardrails.
violated contains v if {
	some v in input.violations
	v in ids
}

default allow := false

allow if {
	count(ids) > 0
	count(violated) == 0
}

default reason := "no_guardrails_loaded"

reason := "violated" if count(violated) > 0

reason := "allowed" if allow

decision := {
	"allow": allow,
	"reason": reason,
	"violated": sort([v | some v in violated]),
	"guardrails": sort([i | some i in ids]),
}
