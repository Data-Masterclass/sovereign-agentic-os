# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
package system.authz_test

import data.system.authz
import rego.v1

runtime := {"env": {"OPA_WRITER_TOKEN": "w-token", "OPA_READER_TOKEN": "r-token"}}

req(method, path, identity) := {"method": method, "path": path, "identity": identity}

anon(method, path) := {"method": method, "path": path}

test_health_without_token if authz.allow with input as anon("GET", ["health"]) with opa.runtime as runtime

test_writer_writes_data if authz.allow with input as req("PUT", ["v1", "data", "grants"], "w-token") with opa.runtime as runtime

test_writer_writes_policies if authz.allow with input as req("PUT", ["v1", "policies", "x"], "w-token") with opa.runtime as runtime

test_writer_reads_config if authz.allow with input as req("GET", ["v1", "config"], "w-token") with opa.runtime as runtime

test_reader_decides_tools if authz.allow with input as req("POST", ["v1", "data", "agentic", "authz", "allow"], "r-token") with opa.runtime as runtime

test_reader_cannot_write if not authz.allow with input as req("PUT", ["v1", "data", "agentic", "authz", "x"], "r-token") with opa.runtime as runtime

test_reader_cannot_read_grants if not authz.allow with input as req("GET", ["v1", "data", "grants"], "r-token") with opa.runtime as runtime

test_reader_cannot_query if not authz.allow with input as req("POST", ["v1", "query"], "r-token") with opa.runtime as runtime

test_anonymous_cannot_write if not authz.allow with input as anon("PUT", ["v1", "data", "grants"]) with opa.runtime as runtime

test_anonymous_cannot_put_policy if not authz.allow with input as anon("PUT", ["v1", "policies", "x"]) with opa.runtime as runtime

test_anonymous_cannot_read_data if not authz.allow with input as anon("GET", ["v1", "data"]) with opa.runtime as runtime

test_anonymous_cannot_query if not authz.allow with input as anon("POST", ["v1", "query"]) with opa.runtime as runtime

test_anonymous_trino_decision if authz.allow with input as anon("POST", ["v1", "data", "trino", "allow"]) with opa.runtime as runtime

test_anonymous_trino_package_root_refused if not authz.allow with input as anon("POST", ["v1", "data", "trino"]) with opa.runtime as runtime

test_anonymous_trino_write_refused if not authz.allow with input as anon("PUT", ["v1", "data", "trino", "allow"]) with opa.runtime as runtime

test_wrong_token_refused if not authz.allow with input as req("PUT", ["v1", "data", "grants"], "nope") with opa.runtime as runtime

test_wrong_token_not_anonymous_for_trino if not authz.allow with input as req("POST", ["v1", "data", "trino", "allow"], "nope") with opa.runtime as runtime

test_empty_env_matches_nothing if {
	not authz.allow with input as req("PUT", ["v1", "data", "x"], "") with opa.runtime as {"env": {}}
}
