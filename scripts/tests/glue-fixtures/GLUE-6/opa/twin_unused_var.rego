# SPDX-License-Identifier: Apache-2.0
# GLUE-6 negative twin: `opa check --strict` MUST refuse this file (assigned variable never used).
package glue6.twin

import rego.v1

allow if {
	unused := input.principal
	true
}
