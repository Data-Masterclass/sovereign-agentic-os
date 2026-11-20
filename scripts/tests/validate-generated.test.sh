#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# AREA:       repo tooling — test for CI rule GLUE-6
# FEATURE:    Proves scripts/validate-generated.sh really runs each component's validator: the real
#             inputs pass, and every negative twin makes exactly its own step FAIL.
# USER STORY: As a reviewer I want evidence that a green GLUE-6 means dbt, Dagster, OPA and
#             kubeconform accepted the generated config — a step that silently did nothing would
#             pass the first half of this test and fail the second.
# ARCHITECTURE:
#   - Two runs of the real script (containers, no mocks): plain, then `--fixtures` with the twins in
#     scripts/tests/glue-fixtures/GLUE-6 added to the real inputs.
#   - The second run builds nothing (`--skip-build`): the first run built the image.
#   - Needs docker + helm + node (the chart's subchart tarballs must be built). Exits 1 on any miss.
set -uo pipefail
cd "$(dirname "$0")/../.."
failures=0
check() {  # check <description> <grep -E pattern> <output>
  if grep -qE "$2" <<<"$3"; then echo "ok   - $1"; else echo "FAIL - $1 (expected /$2/)"; failures=$((failures + 1)); fi
}

real="$(bash scripts/validate-generated.sh ${GLUE6_TEST_BUILD_FLAG:-} 2>&1)"; real_code=$?
printf '%s\n' "$real" | grep '^GLUE-6' | sed 's/^/  real: /'
check "real inputs: exit 0" '^0$' "$real_code"
for step in dbt-parse dbt-compile dagster-definitions-validate opa-check opa-test 'kubeconform\[default\]' 'kubeconform\[stackit\]'; do
  check "real inputs: $step ok" "^GLUE-6 $step: ok" "$real"
done
check "real inputs: no FAIL line" '^GLUE-6: ok' "$real"

twin="$(bash scripts/validate-generated.sh --skip-build --fixtures scripts/tests/glue-fixtures/GLUE-6 2>&1)"; twin_code=$?
printf '%s\n' "$twin" | grep '^GLUE-6' | sed 's/^/  twin: /'
check "twins: exit non-zero" '^[1-9]' "$twin_code"
check "twin dbt: dbt-parse FAILs on the duplicate model" '^GLUE-6 dbt-parse: FAIL twin-duplicate-model' "$twin"
check "twin dbt: the real goldens still parse" '^GLUE-6 dbt-parse: ok — composition-with-tests' "$twin"
check "twin dbt: Dagster refuses the domain too" '^GLUE-6 dagster-definitions-validate: FAIL' "$twin"
check "C1 twin: a duplicate test name FAILs dbt-parse" '^GLUE-6 dbt-parse: FAIL twin-duplicate-test' "$twin"
check "C1 twin: a metric with an unknown measure FAILs dbt-parse" '^GLUE-6 dbt-parse: FAIL twin-unknown-measure' "$twin"
check "C1 twin: … and dbt names the unknown measure" 'measure `no_such_measure` does not exist' "$twin"
check "C1 twin: an invalid cron parses in dbt" '^GLUE-6 dbt-parse: ok — twin-invalid-cron' "$twin"
check "C1 twin: Dagster refuses the invalid-cron domain" 'twin-invalid-cron' "$(printf '%s\n' "$twin" | sed -n '/dagster-definitions-validate: FAIL/,/^GLUE-6 opa/p')"
check "real goldens: dbt compile ok" '^GLUE-6 dbt-compile: ok — composition-with-tests' "$twin"
check "twin rego: opa-check FAILs" '^GLUE-6 opa-check: FAIL' "$twin"
check "twin rego: the reason names the twin file" 'twin_unused_var.rego' "$twin"
check "twin k8s: kubeconform[default] FAILs" '^GLUE-6 kubeconform\[default\]: FAIL' "$twin"
check "twin k8s: kubeconform[stackit] FAILs" '^GLUE-6 kubeconform\[stackit\]: FAIL' "$twin"
check "twin k8s: the reason names the twin manifest" 'glue6-twin' "$twin"

if [ $failures -ne 0 ]; then echo "validate-generated.test: $failures assertion(s) failed"; exit 1; fi
echo "validate-generated.test: ok"
