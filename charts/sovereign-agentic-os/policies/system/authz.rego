# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# OPA's own API authorization (package system.authz), enabled by the chart with
# `--authentication=token --authorization=basic`. OPA evaluates `data.system.authz.allow` for
# every API request; `input.identity` is the bearer token (undefined without one).
# https://www.openpolicyagent.org/docs/security
#
# Identities (tokens from the Secret `opa-tokens`, in OPA's environment — never OPA data):
#   writer  the OS reconciler (os-ui, os-ui-worker, the principal re-assert hook): everything,
#           including data and policy writes, so state is restored after every OPA restart;
#   reader  web-fetch: tool decisions under /v1/data/agentic/authz only.
# Without a token: GET /health (kubelet probes) and Trino's decision queries, POST under
# /v1/data/trino (Trino's OPA plugin has no bearer setting). Everything else is refused.
package system.authz

import rego.v1

default allow := false

# The token values, read from OPA's environment. Empty when unset, which never matches:
# an identity is only compared when it is a non-empty string.
tokens := {
	"writer": object.get(opa.runtime(), ["env", "OPA_WRITER_TOKEN"], ""),
	"reader": object.get(opa.runtime(), ["env", "OPA_READER_TOKEN"], ""),
}

identity := name if {
	is_string(input.identity)
	input.identity != ""
	some name, token in tokens
	token != ""
	input.identity == token
}

# Kubelet probes (readiness and liveness) carry no token.
allow if {
	input.method == "GET"
	input.path == ["health"]
}

allow if identity == "writer"

allow if {
	identity == "reader"
	input.method == "POST"
	array.slice(input.path, 0, 4) == ["v1", "data", "agentic", "authz"]
}

# Trino evaluates its own package; it cannot present a token.
allow if {
	not input.identity
	input.method == "POST"
	count(input.path) > 3
	array.slice(input.path, 0, 3) == ["v1", "data", "trino"]
}
