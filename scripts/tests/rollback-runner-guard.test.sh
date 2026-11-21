#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# =============================================================================
# rollback-runner-guard.test.sh — rollback.sh refuses to roll the data-runner below the build that
# applies column names while any dataset stores mapped names, unless --allow-runner-downgrade.
# =============================================================================
#   bash scripts/tests/rollback-runner-guard.test.sh
#
# The REAL scripts/rollback.sh (with --dry-run) against stubbed helm / kubectl and a stubbed
# mapped-columns probe: no cluster, no network. Each revision's data-runner manifest is the one
# the REAL chart renders (`helm template`): a current digest (true) or a legacy one (false).
# Negative twin: the same downgrade with no mapped dataset, or between two revisions that both
# apply column names, is NOT refused.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
. scripts/tests/assert.sh
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
REAL_HELM=$(command -v helm) || { echo "helm not on PATH"; exit 2; }
ls charts/sovereign-agentic-os/charts/*.tgz >/dev/null 2>&1 || { echo "no subchart .tgz (helm dependency build charts/sovereign-agentic-os)"; exit 2; }

render() { # <true|false> — the data-runner Deployment the real chart renders: a non-legacy
  # digest (true) or the chart's own legacy pin (false). No manual flag exists.
  local set=()
  [ "$1" = true ] && set=(--set dataRunner.image.digest=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)
  "$REAL_HELM" template agentic-os charts/sovereign-agentic-os -n agentic-os --skip-schema-validation \
    "${set[@]+"${set[@]}"}" --show-only templates/extensions/lakehouse/data-runner.yaml 2>/dev/null
}
render true > "$TMP/manifest-true.yaml"
render false > "$TMP/manifest-false.yaml"
check "the chart renders the capability annotation" 'sovereign-os/applies-column-names: "true"' "$(cat "$TMP/manifest-true.yaml")"

BIN=$TMP/bin; mkdir -p "$BIN"
cat > "$BIN/helm" <<'STUB'
#!/usr/bin/env bash
[ "$1" = version ] && { echo "${FAKE_HELM_V:-v4.2.2}"; exit 0; }   # helm-version-guard.sh
case "$*" in
  *" history "*) echo '[{"revision":7,"status":"superseded"},{"revision":8,"status":"deployed"}]' ;;
  *" get manifest "*"--revision 8"*) [ "${FAKE_MANIFEST_FAIL:-}" = 8 ] && exit 1; cat "$FAKE_DIR/rev8.yaml" ;;
  *" get manifest "*"--revision 7"*) cat "$FAKE_DIR/rev7.yaml" ;;
  *) echo "unexpected helm $*" >&2; exit 1 ;;
esac
STUB
cat > "$BIN/kubectl" <<'STUB'
#!/usr/bin/env bash
case " $* " in *" get secrets -o json "*) if [ -n "${FAKE_SECRETS_JSON:-}" ]; then cat "$FAKE_SECRETS_JSON"; else echo '{"items":[]}'; fi; exit 0 ;; esac   # the rotation drift guard
case " $* " in *" get secret "*)
  [ -n "${FAKE_KUBECTL_FAIL:-}" ] && exit 1
  printf '%s' "${FAKE_KUBECTL_OUT:-}" ;; esac
exit 0
STUB
cat > "$BIN/probe" <<'STUB'
#!/usr/bin/env bash
echo "probe $*" >> "$FAKE_DIR/probe.log"
[ "$FAKE_MAPPED" = fail ] && exit 1
echo "$FAKE_MAPPED"
STUB
chmod +x "$BIN"/*
export FAKE_DIR=$TMP

run() { # <rev8 cap> <rev7 cap> <mapped> [args] — sets out
  cp "$TMP/manifest-$1.yaml" "$TMP/rev8.yaml"; cp "$TMP/manifest-$2.yaml" "$TMP/rev7.yaml"
  : > "$TMP/probe.log"
  out=$(PATH="$BIN:$PATH" FAKE_SECRETS_JSON=${FAKE_SECRETS_JSON:-} ROTATION_IN_PROGRESS=${ROTATION_IN_PROGRESS:-} GITHUB_ACTIONS=${GITHUB_ACTIONS:-} FAKE_KUBECTL_OUT=${FAKE_KUBECTL_OUT:-} FAKE_KUBECTL_FAIL=${FAKE_KUBECTL_FAIL:-} FAKE_HELM_V=${FAKE_HELM_V:-} FAKE_MANIFEST_FAIL=${FAKE_MANIFEST_FAIL:-} FAKE_MAPPED=$3 PROD_KUBE_CONTEXT=testprod KUBE_CONTEXT=testprod \
        ROLLBACK_MAPPED_COLUMNS_PROBE="$BIN/probe" bash scripts/rollback.sh --env prod --dry-run "${@:4}" 2>&1)
}

echo "== WP-10: the Secret deletion guard and the Helm 4 check run on rollbacks too"
printf -- '---\napiVersion: v1\nkind: Secret\nmetadata:\n  name: x-secret\n' > "$TMP/x-secret.yaml"
cat "$TMP/manifest-false.yaml" "$TMP/x-secret.yaml" > "$TMP/manifest-sec.yaml"
FAKE_KUBECTL_OUT='x-secret|' run sec false 0
check "a rollback that would delete a live Secret without keep is refused" "ROLLBACK_REFUSED: this change would DELETE the live Secret(s): x-secret" "$out"
FAKE_KUBECTL_OUT='x-secret|keep' run sec false 0
check "with keep on the live Secret it proceeds" "ROLLBACK_DRY_RUN env=prod 8 -> 7" "$out"
FAKE_KUBECTL_FAIL=1 run sec false 0
check "fail closed: a kubectl error refuses the rollback" "ROLLBACK_REFUSED: cannot read the live Secret(s): x-secret" "$out"
FAKE_HELM_V=v3.16.3 run false false 0
check "a Helm 3 client is refused" "ROLLBACK_REFUSED: Helm v3.16.3 is below 4" "$out"

echo "== the rotation drift guard: a rollback must not undo a rotation in progress"
printf -- '---\napiVersion: v1\nkind: Secret\nmetadata:\n  name: valkey-credentials\nstringData:\n  password: older-than-the-rotation\n' > "$TMP/valkey-old.yaml"
cat "$TMP/manifest-false.yaml" "$TMP/valkey-old.yaml" > "$TMP/manifest-vk.yaml"
printf '{"items":[{"metadata":{"name":"valkey-credentials","managedFields":[{"manager":"rotate-secrets","fieldsV1":{"f:data":{"f:password":{}}}}]},"data":{"password":"%s"}}]}' "$(printf rotated-in-the-cluster | base64)" > "$TMP/secrets-rotated.json"
FAKE_SECRETS_JSON=$TMP/secrets-rotated.json run false vk 0
check "refused: the target revision would put the older Valkey password back" "ROLLBACK_REFUSED: this rollback would put OLDER values back into 1 Secret key(s)" "$out"
check "...naming the key" "valkey-credentials/password" "$out"
absent "...printing no value" "older-than-the-rotation" "$out"
absent "...nor the cluster's" "rotated-in-the-cluster" "$out"
FAKE_SECRETS_JSON=$TMP/secrets-rotated.json ROTATION_IN_PROGRESS=1 GITHUB_ACTIONS= run false vk 0
check "ROTATION_IN_PROGRESS lets it through" "ROLLBACK_DRY_RUN env=prod 8 -> 7" "$out"
check "...with a warning" "WARNING ROTATION_IN_PROGRESS is set: this rollback replaces 1 key(s)" "$out"
printf '{"items":[{"metadata":{"name":"valkey-credentials","managedFields":[{"manager":"helm","fieldsV1":{"f:data":{"f:password":{}}}}]},"data":{"password":"%s"}}]}' "$(printf rotated-in-the-cluster | base64)" > "$TMP/secrets-helm.json"
FAKE_SECRETS_JSON=$TMP/secrets-helm.json run false vk 0
check "negative twin: the same difference in a key rotate-secrets does not manage rolls back" "ROLLBACK_DRY_RUN env=prod 8 -> 7" "$out"

echo "== downgrade below the column-name runner while datasets store mapped names"
run true false 3
check "refused" "ROLLBACK_REFUSED: revision 7 runs a data-runner that does not apply column names, and 3 dataset(s)" "$out"
absent "no dry-run verdict" "ROLLBACK_DRY_RUN" "$out"
run true false fail
check "refused when the count cannot be read" "unknown dataset(s) store mapped column names" "$out"
run true false 3 --allow-runner-downgrade
check "the explicit flag lets it through" "ROLLBACK_DRY_RUN env=prod 8 -> 7" "$out"
check "...with a warning" "WARNING: --allow-runner-downgrade: 3 dataset(s)" "$out"

echo "== negative twins: nothing to protect, or no downgrade"
run true false 0
check "no mapped dataset: allowed" "ROLLBACK_DRY_RUN env=prod 8 -> 7" "$out"
run true true 3
check "both revisions apply column names: allowed" "ROLLBACK_DRY_RUN env=prod 8 -> 7" "$out"
[ ! -s "$TMP/probe.log" ] && ok "...and the store is not even probed" || bad "...and the store is not even probed" "probed: $(cat "$TMP/probe.log")"
run false false 3
check "neither applies column names (today's chart): allowed" "ROLLBACK_DRY_RUN env=prod 8 -> 7" "$out"

echo "== fail closed"
FAKE_MANIFEST_FAIL=8 run true false 0
check "a failed helm get manifest refuses" "cannot read the manifest of revision 8" "$out"
mkdir -p "$TMP/noyaml"; printf 'raise ImportError("no PyYAML here")\n' > "$TMP/noyaml/yaml.py"
PYTHONPATH=$TMP/noyaml run true false 0
check "a missing PyYAML refuses" "PyYAML missing or the manifest does not parse" "$out"
absent "...never a dry-run verdict" "ROLLBACK_DRY_RUN" "$out"

echo "== the only supported path is documented"
check "rollback.sh says manual helm rollback is not guarded" "A manual \`helm rollback\` is NOT guarded" "$(cat scripts/rollback.sh)"
check "rollback.yml says it too" "a manual \`helm rollback\`" "$(cat .github/workflows/rollback.yml)"

echo "== the workflow passes the override through"
check "rollback.yml has the input" "allow_runner_downgrade:" "$(cat .github/workflows/rollback.yml)"
check "rollback.yml passes the flag" '${ALLOW_RUNNER_DOWNGRADE:+--allow-runner-downgrade}' "$(cat .github/workflows/rollback.yml)"

finish rollback-runner-guard
