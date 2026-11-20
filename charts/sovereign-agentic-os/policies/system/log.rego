# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# Decision-log mask (package system.log). OPA evaluates `mask` with the decision
# event as input and erases each listed JSON pointer before the entry is written.
# Wired by `decision_logs.mask_decision: system/log/mask` in the chart's OPA config.
# https://www.openpolicyagent.org/docs/management-decision-logs#masking-sensitive-data
package system.log

import rego.v1

# A bearer token passed in the input is never logged.
mask contains "/input/token"
