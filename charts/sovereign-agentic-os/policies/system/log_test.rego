# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# Unit tests for the decision-log mask (package system.log). OPA evaluates
# data.system.log.mask with the decision event as input and erases each listed
# JSON pointer before the entry is written (decision_logs.mask_decision).
package system.log_test

import rego.v1

import data.system.log

event := {"input": {"principal": "sales", "tool": "query", "token": "t"}, "result": true}

test_masks_bearer_token if "/input/token" in log.mask with input as event

test_keeps_principal_and_tool if {
	m := log.mask with input as event
	not "/input/principal" in m
	not "/input/tool" in m
}
