# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# Decision-log policy (package system.log), wired by the chart's OPA config:
#   decision_logs.drop_decision: system/log/drop
#   decision_logs.mask_decision: system/log/mask
# OPA evaluates both with the decision event as `input`; `drop` runs first.
# https://www.openpolicyagent.org/docs/management-decision-logs
package system.log

import rego.v1

# --- drop -------------------------------------------------------------------
# A policy decision always carries an `input` document (os-ui, Trino). A request
# without one is a plain read of a data document (e.g. `GET /v1/data/grants`),
# whose result is the stored document itself, not a decision: it is not logged.
drop if not "input" in object.keys(input)

# --- mask -------------------------------------------------------------------
# Any key whose name looks secret-bearing is erased, at any depth of the input or
# the result. Matching is on the key name, case-insensitive, as a substring
# (`access_token`, `X-Api-Key`, `Authorization`, `db_password`, ...).
secret_key := `(?i)(token|passw(or)?d|secret|authorization|cookie|api[-_]?key)`

mask contains pointer if {
	some doc in ["input", "result"]
	walk(input[doc], [path, _])
	count(path) > 0
	key := path[count(path) - 1]
	is_string(key)
	regex.match(secret_key, key)
	pointer := concat("/", array.concat(["", doc], [escape(p) | some p in path]))
}

# JSON pointer segment (RFC 6901): `~` -> `~0`, `/` -> `~1`; array indices as numbers.
escape(p) := replace(replace(p, "~", "~0"), "/", "~1") if is_string(p)

escape(p) := format_int(p, 10) if is_number(p)
