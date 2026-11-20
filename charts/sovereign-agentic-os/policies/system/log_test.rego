# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# Unit tests for the decision-log policy (package system.log): `mask` erases every
# secret-bearing key at any depth; `drop` skips plain data-document reads.
package system.log_test

import rego.v1

import data.system.log

event := {
	"path": "agentic/authz/decision",
	"input": {
		"principal": "sales",
		"tool": "query",
		"token": "t",
		"password": "p",
		"client_secret": "s",
		"headers": {"Authorization": "Bearer x", "Cookie": "c", "X-Api-Key": "k"},
		"args": {"nested": [{"api_key": "k2"}]},
		"we/ird~key_token": "w",
	},
	"result": {"allow": true, "session_token": "r"},
}

test_masks_token if "/input/token" in log.mask with input as event

test_masks_password if "/input/password" in log.mask with input as event

test_masks_secret if "/input/client_secret" in log.mask with input as event

test_masks_authorization_header if "/input/headers/Authorization" in log.mask with input as event

test_masks_cookie if "/input/headers/Cookie" in log.mask with input as event

test_masks_api_key_header if "/input/headers/X-Api-Key" in log.mask with input as event

test_masks_api_key_inside_array if "/input/args/nested/0/api_key" in log.mask with input as event

test_masks_secret_in_result if "/result/session_token" in log.mask with input as event

test_escapes_json_pointer if "/input/we~1ird~0key_token" in log.mask with input as event

test_keeps_principal_tool_and_containers if {
	m := log.mask with input as event
	not "/input/principal" in m
	not "/input/tool" in m
	not "/input/headers" in m
	not "/result/allow" in m
	count(m) == 9
}

test_nothing_to_mask if {
	m := log.mask with input as {"input": {"principal": "sales", "tool": "query"}, "result": true}
	count(m) == 0
}

test_drops_document_read_without_input if log.drop with input as {"path": "grants", "result": {"u": ["query"]}}

test_keeps_decision_with_input if {
	not log.drop with input as {"path": "agentic/authz/allow", "input": {"principal": "s", "tool": "q"}, "result": true}
}
