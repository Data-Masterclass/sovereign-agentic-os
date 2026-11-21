#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# rotation-datastores.test.sh — scripts/lib/rotation-datastores.py (rotation round 2), offline.
#   bash scripts/tests/rotation-datastores.test.sh
# The end-to-end proof on the real components is scripts/tests/secret-rotation/rehearse-round2.sh.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
. scripts/tests/assert.sh
L="python3 scripts/lib/rotation-datastores.py"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT; chmod 700 "$T"
# The chart defaults stand in for `helm get values --all` (the computed values).
python3 -c 'import json,yaml; print(json.dumps(yaml.safe_load(open("charts/sovereign-agentic-os/values.yaml"))))' > "$T/values.json"

echo "items: every rotated credential of the chart, from the values"
out=$($L items "$T/values.json")
for want in "postgres	postgres-langfuse-credentials	password	postgres.local.password	langfuse	langfuse" \
            "postgres	postgres-litellm-credentials	password	postgres.extraDatabases[litellm].localPassword	litellm	litellm" \
            "postgres	postgres-agent-runs-credentials	password	postgres.extraDatabases[agent_runs].localPassword	agent_runs	agent_runs" \
            "clickhouse	clickhouse-credentials	password" "valkey	valkey-credentials	password" \
            "minio	object-storage-credentials	AWS_SECRET_ACCESS_KEY	objectStorage.local.secretKey" \
            "agent-key	agent-litellm-key	apiKey	litellmAgentKey.local.value" \
            "litellm-master	litellm-credentials	masterkey	litellmMasterKey"; do
  check "  $(cut -f1,2 <<<"$want" | tr '\t' ' ')" "$want" "$out"
done
n_pg=$(python3 -c 'import json; print(1+len(json.load(open("'"$T/values.json"'"))["postgres"]["extraDatabases"]))')
holds "  one Postgres item per role ($n_pg)" [ "$(grep -c '^postgres' <<<"$out")" = "$n_pg" ]
python3 -c 'import json,sys; v=json.load(open(sys.argv[1])); v["objectStorage"]["mode"]="external"; v["postgres"]["engine"]="cnpg"; json.dump(v,open(sys.argv[2],"w"))' "$T/values.json" "$T/ext.json"
out2=$($L items "$T/ext.json")
absent "  external object storage: no MinIO item" "object-storage-credentials" "$out2"
absent "  CNPG engine: no Postgres item (CNPG manages its roles)" "postgres-langfuse-credentials" "$out2"

echo "build: new random values, the rollback, mode 600, never over a file"
$L build "$T/values.json" "$T/ov.yaml" postgres,clickhouse,valkey,minio,litellm-master,agent-key > "$T/build.out"; rc=$?; rc_is "build exits 0" 0
mode() { python3 -c 'import os,sys; print(oct(os.stat(sys.argv[1]).st_mode & 0o777)[2:])' "$1"; }
holds "  overlay mode 600" [ "$(mode "$T/ov.yaml")" = 600 ]
holds "  rollback mode 600" [ "$(mode "$T/ov.rollback.yaml")" = 600 ]
for v in langfuse-local-dev litellm-local-dev clickhouse-local-dev valkey-local-dev agentic-os-local-secret sk-agents-local-dev sk-litellm-local-dev-master; do
  absent "  no default in the overlay ($v)" "$v" "$(cat "$T/ov.yaml")"
done
check "  the rollback holds the current values" "clickhouse-local-dev" "$(cat "$T/ov.rollback.yaml")"
absent "  build prints no value" "$($L get "$T/ov.yaml" clickhouse.local.password)" "$(cat "$T/build.out")"
check "  build prints sha prefixes per Secret" "clickhouse-credentials/password " "$(cat "$T/build.out")"
holds "  the extra databases are written WHOLE (Helm replaces lists)" python3 -c '
import yaml,json,sys
o=yaml.safe_load(open(sys.argv[1]))["postgres"]["extraDatabases"]; v=json.load(open(sys.argv[2]))["postgres"]["extraDatabases"]
assert [e["name"] for e in o]==[e["name"] for e in v]
assert all(set(a)==set(b) and all(a[k]==b[k] for k in a if k!="localPassword") for a,b in zip(o,v))
assert all(a["localPassword"]!=b["localPassword"] for a,b in zip(o,v) if "localPassword" in b)' "$T/ov.yaml" "$T/values.json"
holds "  the master key starts with sk-" bash -c "$L get $T/ov.yaml litellmMasterKey | grep -q '^sk-'"
holds "  the agent key starts with sk-" bash -c "$L get $T/ov.yaml litellmAgentKey.local.value | grep -q '^sk-'"
holds "  the MinIO secret key is 40 characters" [ "$($L get "$T/ov.yaml" objectStorage.local.secretKey | wc -c | tr -d ' ')" = 40 ]
holds "  the access key is not in the overlay" bash -c "! grep -q accessKey $T/ov.yaml"
$L build "$T/values.json" "$T/ov.yaml" valkey >/dev/null 2>&1; rc=$?; rc_is "  a second build over the same file refuses" 1
$L build "$T/values.json" "$T/ov2.yaml" redis >/dev/null 2>&1; rc=$?; rc_is "  an unknown component refuses" 1
$L build "$T/values.json" "$T/ov3.yaml" valkey >/dev/null
check "  --only valkey: only Valkey" "valkey:" "$(cat "$T/ov3.yaml")"
absent "  ... nothing else" "postgres:" "$(cat "$T/ov3.yaml")"

echo "get: dotted and named-list paths"
check "  a named list element" "litellm-local-dev" "$($L get "$T/values.json" 'postgres.extraDatabases[litellm].localPassword')"
holds "  an absent path is empty" [ -z "$($L get "$T/values.json" 'postgres.extraDatabases[nope].localPassword')" ]

echo "scram: a PostgreSQL SCRAM-SHA-256 verifier"
v=$(printf 'pencil' | $L scram)
holds "  the stored format" bash -c "grep -Eq '^SCRAM-SHA-256\\\$4096:[A-Za-z0-9+/=]{24}\\\$[A-Za-z0-9+/=]{44}:[A-Za-z0-9+/=]{44}\$' <<<'$v'"
absent "  the password is not in it" "pencil" "$v"
holds "  a random salt (two verifiers differ)" [ "$v" != "$(printf 'pencil' | $L scram)" ]
holds "  StoredKey/ServerKey follow RFC 5802 for its salt" python3 - "$v" <<'PY'
import base64, hashlib, hmac, sys
m, rest = sys.argv[1].split("$", 1); it_salt, keys = rest.split("$"); it, salt = it_salt.split(":"); sk, svk = keys.split(":")
salted = hashlib.pbkdf2_hmac("sha256", b"pencil", base64.b64decode(salt), int(it))
assert base64.b64decode(sk) == hashlib.sha256(hmac.new(salted, b"Client Key", "sha256").digest()).digest()
assert base64.b64decode(svk) == hmac.new(salted, b"Server Key", "sha256").digest()
PY
printf '' | $L scram >/dev/null 2>&1; rc=$?; rc_is "  an empty password refuses" 1
echo "rotate-secrets.sh: a run that stops early never exits 0 (bash 3.2 + EXIT trap + unset variable)"
mkdir -p "$T/rs/scripts/ops"; ln -s "$PWD/scripts/lib" "$T/rs/scripts/lib"
sed 's/^  ds-plan) ds_plan ;;$/  ds-plan) echo "$unset_for_this_test" ;;/' scripts/ops/rotate-secrets.sh > "$T/rs/scripts/ops/rotate-secrets.sh"
holds "  the twin really changed the dispatcher" grep -q unset_for_this_test "$T/rs/scripts/ops/rotate-secrets.sh"
# shellcheck disable=SC2034  # rc is read by rc_is (assert.sh)
out=$(/bin/bash "$T/rs/scripts/ops/rotate-secrets.sh" ds-plan 2>&1); rc=$?
rc_is "  an unset variable mid-run exits 1" 1
# bash 3.2 needs the guard (it would exit 0 and the guard says so); bash 5 exits 1 by itself.
case $out in *"stopped before its end"*|*"unbound variable"*) ok "  ... and the cause is shown" ;; *) bad "  ... and the cause is shown" "$out" ;; esac
finish rotation-datastores
