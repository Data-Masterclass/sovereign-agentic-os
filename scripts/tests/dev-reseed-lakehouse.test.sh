#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# scripts/dev/reseed-lakehouse.sh against stub kubectl/helm: it refuses an unmarked cluster and the
# production context, re-creates the three lakehouse hook Jobs from `helm get hooks` in weight order
# (and only those Jobs), stops on a failed one and keeps it, and skips a hook the release does not have.
set -uo pipefail
cd "$(dirname "$0")/../.."
REPO=$PWD
. scripts/tests/assert.sh
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
BIN=$T/bin; mkdir -p "$BIN"
export FAKE_LOG=$T/calls.log FAKE_CREATED=$T/created.yaml
hooks() { for j in polaris-catalog-init dbt-build northpeak-marts-init; do
  [ "${FAKE_NO_DBT:-}" = 1 ] && [ $j = dbt-build ] && continue
  printf -- '---\n# Source: x/%s.yaml\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: %s\n---\n# Source: x/%s.yaml\napiVersion: batch/v1\nkind: Job\nmetadata:\n  name: %s\n  annotations:\n    "helm.sh/hook": post-install\n' $j $j $j $j; done; }
export -f hooks
cat > "$BIN/kubectl" <<'S'
#!/usr/bin/env bash
echo "kubectl $*" >> "$FAKE_LOG"
case "$*" in
  "config view"*) exit 0 ;;
  *"get configmap sovereign-os-environment"*) printf '%s' "${FAKE_MARKER-dev}" ;;
  *"get deploy polaris"*) printf relational-jdbc ;;
  *" create -f -"*) cat >> "$FAKE_CREATED"; echo "~~~" >> "$FAKE_CREATED" ;;
  *"wait --for=condition=complete job/"*) case "$*" in *"job/${FAKE_FAIL_JOB:-none}"*) exit 1 ;; esac ;;
  *) : ;;
esac
S
cat > "$BIN/helm" <<'S'
#!/usr/bin/env bash
echo "helm $*" >> "$FAKE_LOG"
case "$*" in *"get hooks"*) hooks ;; *) exit 1 ;; esac
S
chmod +x "$BIN/kubectl" "$BIN/helm"
run() { : > "$FAKE_LOG"; : > "$FAKE_CREATED"; out=$(env PATH="$BIN:$PATH" "$@" bash "$REPO/scripts/dev/reseed-lakehouse.sh" --no-seed 2>&1); rc=$?; }

run env DEV_KUBE_CONTEXT=dmagenticos
rc_is "the production context is refused" 1
absent "  nothing is created" "create -f" "$(cat "$FAKE_LOG")"
run env FAKE_MARKER=prod
rc_is "a cluster not marked dev is refused" 1
absent "  nothing is created" "create -f" "$(cat "$FAKE_LOG")"

run
rc_is "on the marked dev cluster: exit 0" 0
check "  ends OK" "RESEED_LAKEHOUSE_OK context=dmagosdev" "$out"
order=$(grep -o 'job/[a-z-]*' "$FAKE_LOG" | grep -v '^job/$' | awk '!s[$0]++' | tr '\n' ' ')
check "  in Helm's weight order" "job/polaris-catalog-init job/dbt-build job/northpeak-marts-init" "$order"
holds "  only Jobs are created (no ConfigMap from the hooks)" bash -c "! grep -q 'kind: ConfigMap' '$FAKE_CREATED'"
holds "  exactly three Jobs" [ "$(grep -c '^kind: Job' "$FAKE_CREATED")" = 3 ]
holds "  every kubectl call names the dev context" bash -c "! grep '^kubectl' '$FAKE_LOG' | grep -v '^kubectl config' | grep -v -- '--context dmagosdev'"

run env FAKE_FAIL_JOB=dbt-build
rc_is "a failed hook stops the run" 1
check "  saying which" "dbt-build did not complete" "$out"
absent "  the next hook is not started" "northpeak-marts-init" "$(grep 'create\|wait' "$FAKE_LOG")"
absent "  the failed Job is kept" "delete job dbt-build --wait=false" "$(cat "$FAKE_LOG")"

run env FAKE_NO_DBT=1
rc_is "a hook the release does not render is skipped" 0
check "  saying so" "dbt-build: not a hook of this release" "$out"
finish dev-reseed-lakehouse.test.sh && echo DEV_RESEED_LAKEHOUSE_TESTS_OK
