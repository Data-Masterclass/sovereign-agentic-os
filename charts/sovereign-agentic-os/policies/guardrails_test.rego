# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# Unit tests for package os.guardrails, with the data shape os-ui commits to git
# (knowledge/workflows/<slug>/guardrails.json) mocked at data.os_data.guardrails.
package os.guardrails_test

import rego.v1

import data.os.guardrails

bank := {"guardrails": [
	{"id": "wr2", "level": "workflow", "text": "Never submit without sign-off"},
	{"id": "sr1", "level": "step", "step_id": "verify", "text": "Error rate < 0.1%"},
]}

test_no_violation_allows if {
	d := guardrails.decision with input as {"workflow_id": "wf_bank", "violations": []}
		with data.os_data.guardrails as {"wf_bank": bank}
	d == {"allow": true, "reason": "allowed", "violated": [], "guardrails": ["sr1", "wr2"]}
}

test_missing_violations_field_allows if {
	d := guardrails.decision with input as {"workflow_id": "wf_bank"}
		with data.os_data.guardrails as {"wf_bank": bank}
	d.allow == true
}

test_one_violation_denies if {
	d := guardrails.decision with input as {"workflow_id": "wf_bank", "violations": ["sr1"]}
		with data.os_data.guardrails as {"wf_bank": bank}
	d == {"allow": false, "reason": "violated", "violated": ["sr1"], "guardrails": ["sr1", "wr2"]}
}

test_violation_of_another_workflow_is_ignored if {
	d := guardrails.decision with input as {"workflow_id": "wf_bank", "violations": ["x9"]}
		with data.os_data.guardrails as {"wf_bank": bank}
	d.allow == true
	d.violated == []
}

test_unknown_workflow_fails_closed if {
	d := guardrails.decision with input as {"workflow_id": "wf_other", "violations": []}
		with data.os_data.guardrails as {"wf_bank": bank}
	d == {"allow": false, "reason": "no_guardrails_loaded", "violated": [], "guardrails": []}
}

test_no_data_fails_closed if {
	d := guardrails.decision with input as {"workflow_id": "wf_bank", "violations": []}
		with data.os_data.guardrails as {}
	d.allow == false
	d.reason == "no_guardrails_loaded"
}

test_empty_guardrail_list_fails_closed if {
	d := guardrails.decision with input as {"workflow_id": "wf_bank", "violations": []}
		with data.os_data.guardrails as {"wf_bank": {"guardrails": []}}
	d.allow == false
}
