#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# =============================================================================
# rotate-secrets.test.sh — scripts/ops/rotate-secrets.sh against a fake kubectl / helm.
# =============================================================================
#   bash scripts/tests/rotate-secrets.test.sh
#
# No cluster, no network. Asserts:
#   * prepare with no salt set and stored values picks the RE-KEY path: a step-1 overlay with the
#     master key S and LITELLM_MIGRATE_FROM_MASTER_KEY=<old>, a final overlay with salt S, a new
#     master key and the variable removed (null), plus the in-place secrets; every file mode 600;
#   * the Langfuse encryptionKey is rotated only when no encrypted Langfuse entry exists;
#   * nothing prepare prints contains any of the old or new values;
#   * negative twins: --path none-stored is refused while LiteLLM's scan finds a stored value;
#     plan refuses an overlay prepared for another cluster, and an overlay for the wrong step
#     (the live master key is not the one it expects) — both before helm is called.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
. scripts/tests/assert.sh
python3 -c 'import yaml' 2>/dev/null || { [ -n "${CI:-}" ] && { echo "PyYAML missing — FAILING because CI is set"; exit 1; }; echo "PyYAML missing — SKIPPED"; exit 0; }
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
export FAKE=$T/fake PATH="$PWD/scripts/tests/fixtures/rotate-secrets:$PATH" SOVEREIGN_SECRETS_DIR=$T/secrets
mkdir -p "$FAKE/secrets"/{litellm-credentials,langfuse-init,langfuse-core-secrets,agent-runtime-token}
echo -n uid-live > "$FAKE/uid"
OLD=sk-old-master-$RANDOM$RANDOM
printf '%s' "$OLD" > "$FAKE/secrets/litellm-credentials/masterkey"
printf 'ui-old-%s' $RANDOM > "$FAKE/secrets/litellm-credentials/UI_PASSWORD"
printf 'pk-lf-old%s' $RANDOM > "$FAKE/secrets/langfuse-init/LANGFUSE_INIT_PROJECT_PUBLIC_KEY"
printf 'sk-lf-old%s' $RANDOM > "$FAKE/secrets/langfuse-init/LANGFUSE_INIT_PROJECT_SECRET_KEY"
printf 'salt-old' > "$FAKE/secrets/langfuse-core-secrets/salt"
printf 'nextauth-old' > "$FAKE/secrets/langfuse-core-secrets/nextauthSecret"
printf 'a1b2%.0s' 1 > "$FAKE/secrets/langfuse-core-secrets/encryptionKey"
printf 'agent-old' > "$FAKE/secrets/agent-runtime-token/token"
echo '{"salt_key_set": false, "columns": {"LiteLLM_Config.param_value": {"rows": 1, "effective": 2}, "LiteLLM_TeamTable.metadata": {"rows": 1, "effective": 1}}, "total": {"effective": 3}}' > "$FAKE/scan.json"
printf 'llm_api_keys|0\nactions|0\nsso_configs|-1\n' > "$FAKE/lfenc.txt"
RS=scripts/ops/rotate-secrets.sh
G() { python3 scripts/lib/rotation-files.py get "$1" "$2"; }

echo "prepare: no salt, 3 stored values → re-key"
out=$(bash $RS prepare --context fake 2>&1); rc=$?
rc_is "prepare succeeds" 0
check "re-key path chosen" "PATH: re-key" "$out"
check "LiteLLM's scan counted" "values decryptable with the key in use: 3" "$out"
check "the live version without its digest" "--from-registry 9.9.9" "$out"
S1=$(ls "$T"/secrets/overlays/rotation-*.step1.yaml 2>/dev/null | head -1); F=${S1%.step1.yaml}.yaml
holds "step-1 and final overlays written" test -f "$S1" -a -f "$F" -a -f "${F%.yaml}.rollback.yaml" -a -f "${F%.yaml}.rollback-step1.yaml" -a -f "${F%.yaml}.state.json"
modes=$(python3 -c 'import os,sys; print(" ".join(oct(os.stat(f).st_mode & 0o777)[2:] for f in sys.argv[1:]))' "$T"/secrets/overlays/*)
check "every file mode 600" "600" "$modes"
absent "  ... and no other mode" "644" "$modes"
S=$(G "$S1" litellmMasterKey)
check "step 1 migrates from the old master key" "$OLD" "$(G "$S1" litellm.envVars.LITELLM_MIGRATE_FROM_MASTER_KEY)"
check "final salt = step-1 master key" "$S" "$(G "$F" litellmSaltKey.value)"
holds "final master key is new" test "$(G "$F" litellmMasterKey)" != "$S" -a "$(G "$F" litellmMasterKey)" != "$OLD"
check "final empties the migration variable" "LITELLM_MIGRATE_FROM_MASTER_KEY: ''" "$(cat "$F")"
holds "in-place secrets in the final overlay" test -n "$(G "$F" agentRuntime.token)" -a -n "$(G "$F" litellmUI.password)" -a -n "$(G "$F" langfuseCoreSecrets.nextauthSecret)" -a -n "$(G "$F" langfuseCoreSecrets.salt)"
holds "encryptionKey rotated (no encrypted Langfuse entry)" test -n "$(G "$F" langfuseCoreSecrets.encryptionKey)"
check "rollback keeps the salt" "$S" "$(G "${F%.yaml}.rollback.yaml" litellmSaltKey.value)"
leak=""; for v in "$OLD" "$S" "$(G "$F" litellmMasterKey)" "$(G "$F" langfuseInit.secretKey)" "$(G "$F" litellmUI.password)" "$(cat "$FAKE/secrets/litellm-credentials/UI_PASSWORD")"; do case $out in *"$v"*) leak=1 ;; esac; done
holds "prepare printed no value" test -z "$leak"
holds "state file holds no value" sh -c "! grep -qF -- '$OLD' '${F%.yaml}.state.json' && ! grep -qF -- '$S' '${F%.yaml}.state.json'"

echo "Langfuse encrypted entries present → encryptionKey kept"
printf 'llm_api_keys|2\n' > "$FAKE/lfenc.txt"
before=$(ls "$T"/secrets/overlays/ | sort)
out=$(bash $RS prepare --context fake 2>&1); rc=$?
rc_is "a second prepare in the same second succeeds (no file name collision)" 0
check "reported" "encrypted entr(ies) exist → NOT rotated" "$out"
F2=$(comm -13 <(echo "$before") <(ls "$T"/secrets/overlays/ | sort) | grep -E '^rotation-[0-9-]+-[0-9a-f]+\.yaml$' | head -1); F2=$T/secrets/overlays/$F2
holds "no encryptionKey in the overlay" test -z "$(G "$F2" langfuseCoreSecrets.encryptionKey)"
printf 'llm_api_keys|0\n' > "$FAKE/lfenc.txt"

echo "negative twins"
out=$(bash $RS prepare --context fake --path none-stored 2>&1); rc=$?
rc_is "none-stored refused while values are stored" 1
check "  ... saying why" "LiteLLM's scan finds 3 stored value(s)" "$out"
: > "$FAKE/helm.log"
out=$(bash $RS plan --overlay "$S1" --context fake 2>&1); rc=$?
check "plan: right cluster, right step passes the binding" "overlay belongs to this cluster" "$out"
check "  ... and the master-key check" "live master key is the one this step expects" "$out"
echo -n uid-OTHER > "$FAKE/uid"; : > "$FAKE/helm.log"
out=$(bash $RS plan --overlay "$S1" --context fake 2>&1); rc=$?
rc_is "plan refuses an overlay from another cluster" 1
check "  ... naming the cause" "prepared for another cluster" "$out"
holds "  ... before helm is called" test ! -s "$FAKE/helm.log"
out=$(bash $RS verify --overlay "$S1" --context fake 2>&1); rc=$?
rc_is "verify refuses it too" 1
echo -n uid-live > "$FAKE/uid"; : > "$FAKE/helm.log"
out=$(bash $RS plan --overlay "$F" --context fake 2>&1); rc=$?
rc_is "plan refuses the final overlay before step 1 is live" 1
check "  ... naming the cause" "wrong step, already applied" "$out"
holds "  ... before helm is called" test ! -s "$FAKE/helm.log"
out=$(bash $RS plan --overlay "$S1" --context fake --release other 2>&1); rc=$?
rc_is "plan refuses another release name" 1

finish rotate-secrets
