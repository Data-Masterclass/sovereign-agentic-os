# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschraenkt)
#
# Internal cross-domain Marketplace — import authorization at the policy boundary.
# Same OPA instance as agentic.authz / trino; a separate package so nothing else
# is touched. This is the compiled, server-side expression of "import = a governed
# grant": the os-ui import adapter records the grant + RLS scope, and THIS policy
# is the default-deny gate a live deployment evaluates before a cross-domain read
# is allowed. Mirrors marketplace-golden-path.md + data-policy-compiler.md.
#
#   input = {
#     "consumer_domain": "marketing",
#     "owner_domain":    "sales",
#     "product_type":    "metric",
#     "mode":            "read-grant",   # read-grant|fork|template|deploy-instance
#     "access_policy":   "open"          # open|approval
#   }
#
# Decision: allow (auto-grant) iff the product is open; else needs_approval
# (the import is held in the Governance inbox). Own-domain products are always
# allowed (they already belong to the consumer). The row scope is enforced
# downstream by Trino/OPA (trino.rego), Cube and OpenSearch DLS, per type.

package marketplace

import rego.v1

default allow := false

# Importing within your own domain is not a cross-domain grant — always allowed.
own_domain if input.consumer_domain == input.owner_domain

# An open product auto-grants; RLS still scopes the rows downstream.
open_product if input.access_policy == "open"

allow if own_domain
allow if open_product

# Approval-required imports (shared creds / shared compute, or owner-set) are
# held: not allowed until Governance clears the request.
needs_approval if {
    not own_domain
    input.access_policy == "approval"
}

# Which engine carries the per-viewer RLS for a read-in-place grant (informational
# in the decision; the actual filter is compiled into that engine).
rls_engine := "cube-rls" if input.product_type in {"metric", "dashboard"}
rls_engine := "opensearch-dls" if input.product_type in {"knowledge", "file"}
rls_engine := "opa-trino" if input.product_type in {"dataset", "transformation"}
rls_engine := "none" if input.mode in {"fork", "template", "deploy-instance"}

decision := {
    "allow": allow,
    "needs_approval": needs_approval,
    "consumer_domain": input.consumer_domain,
    "owner_domain": input.owner_domain,
    "product_type": input.product_type,
    "mode": input.mode,
    "rls_engine": rls_engine,
}
