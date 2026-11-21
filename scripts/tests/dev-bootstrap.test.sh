#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# =============================================================================
# dev-bootstrap.test.sh — scripts/dev/bootstrap-secrets.sh and the dev profile, without a cloud.
# =============================================================================
#   bash scripts/tests/dev-bootstrap.test.sh
#
# tofu and kubectl are stubs (the dev state's outputs; a kubeconfig of two contexts; every
# `kubectl apply` is logged, its stdin kept). The chart is rendered with the REAL helm.
#   - it refuses the production context, and a context whose API server is not the dev state's;
#   - it writes the environment=dev marker and the Secrets to the dev context only;
#   - the overlay replaces EVERY credential the chart renders: rendering values.dev.yaml + the
#     generated overlay, no Secret value equals what the chart renders without it (the literals
#     of values.yaml), and the demo users are the synthetic Northpeak cast;
#   - no generated value appears in the script's output.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
REPO=$PWD
# shellcheck source=scripts/tests/assert.sh
. scripts/tests/assert.sh
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
command -v helm >/dev/null || { echo "helm not on PATH"; exit 2; }
ls charts/sovereign-agentic-os/charts/*.tgz >/dev/null 2>&1 || { echo "no subchart .tgz (helm dependency build charts/sovereign-agentic-os)"; exit 2; }
BIN=$TMP/bin; mkdir -p "$BIN"
export FAKE_LOG=$TMP/calls.log FAKE_APPLIED=$TMP/applied.yaml
DEV=https://api.dev.example.invalid PROD=https://api.prod.example.invalid

cat > "$BIN/tofu" <<STUB
#!/usr/bin/env bash
# tofu -chdir=<dir> output -raw <name>
case "\$4" in
  environment) printf dev ;;
  kubeconfig)  printf 'clusters:\n- cluster: {server: "%s"}\n  name: dmagosdev\n' "\${FAKE_STATE_SERVER:-$DEV}" ;;
  object_storage_bucket) printf dm-agentic-os-dev-backups ;;
  object_storage_endpoint) printf https://object.storage.eu01.onstackit.cloud ;;
  object_storage_access_key) printf AKFAKEDEVKEY ;;
  object_storage_secret_key) printf SKFAKEDEVSECRETVALUE ;;
  ingress_public_ip) printf 192.0.2.10 ;;
esac
STUB
cat > "$BIN/kubectl" <<STUB
#!/usr/bin/env bash
echo "kubectl \$*" >> "\$FAKE_LOG"
all="\$*"
if [ "\$1" = config ]; then
  case \$all in
    *'contexts[?(@.name=="dmagosdev")]'*)   printf cl-dev ;;
    *'contexts[?(@.name=="dmagenticos")]'*) printf cl-prod ;;
    *'clusters[?(@.name=="cl-dev")]'*)      printf '%s' "$DEV" ;;
    *'clusters[?(@.name=="cl-prod")]'*)     printf '%s' "$PROD" ;;
  esac
  exit 0
fi
case \$all in
  *" apply -f -"*)  cat >> "\$FAKE_APPLIED"; echo --- >> "\$FAKE_APPLIED"
                    case \$(tail -40 "\$FAKE_APPLIED") in *"environment: dev"*) touch "\$FAKE_LOG.marked" ;; esac ;;
  *"get configmap sovereign-os-environment"*) [ -f "\$FAKE_LOG.marked" ] && printf dev ;;
  *"create secret"*" --dry-run=client -o yaml"*)
    # the REAL kubectl renders the Secret client-side; it needs no cluster and no context
    args=(); skip=''
    for a in "\$@"; do
      if [ -n "\$skip" ]; then skip=''; continue; fi
      if [ "\$a" = --context ]; then skip=1; continue; fi
      args+=("\$a")
    done
    KUBECONFIG=/dev/null exec "$(command -v kubectl || echo /bin/false)" "\${args[@]}" ;;
  *"get ns"*) exit 0 ;;
  *"get secret postgres-governance-admin"*) [ -s "\$FAKE_GOV_SECRET" ] && cat "\$FAKE_GOV_SECRET" ;;
  *"get pod pg-0"*) [ -n "\${FAKE_PG_READY:-}" ] && printf true ;;
  *"exec -i pg-0"*) cat > "\$FAKE_LOG.psql" ;;
esac
STUB
chmod +x "$BIN"/*
command -v kubectl >/dev/null || { echo "kubectl not on PATH (client-side dry-run renders the Secrets)"; exit 2; }

run() { # run [env...] — bootstrap with the stubs; sets out, rc
  rm -f "$FAKE_LOG" "$FAKE_LOG.marked" "$FAKE_APPLIED"; : > "$FAKE_LOG"
  out=$(env PATH="$BIN:$PATH" TF="$BIN/tofu" DEV_PRIVATE_DIR="$TMP/private" "$@" bash scripts/dev/bootstrap-secrets.sh 2>&1); rc=$?
}

echo "== refusals"
run DEV_KUBE_CONTEXT=dmagenticos
rc_is "NEGATIVE TWIN: the production context is refused" 1
check "with the reason" "DEV_KUBE_CONTEXT is the production context" "$out"
absent "nothing is applied" " apply " "$(cat "$FAKE_LOG")"
run FAKE_STATE_SERVER=$PROD
rc_is "NEGATIVE TWIN: a context whose server is not the dev state's is refused" 1
absent "nothing is applied" " apply " "$(cat "$FAKE_LOG")"

echo "== the dev cluster"
mkdir -p "$TMP/private"; chmod 700 "$TMP/private"
( umask 077; printf 'STACKIT-FAKE-MODEL-KEY-0123456789' > "$TMP/private/stackit-model-key" )
run
rc_is "bootstrap on the dev context exits 0" 0
check "it ends OK" "BOOTSTRAP_SECRETS_OK context=dmagosdev" "$out"
holds "every kubectl call names the dev context" bash -c "! grep -v '^kubectl config' '$FAKE_LOG' | grep -v -- '--context dmagosdev'"
check "the marker is applied" "environment: dev" "$(cat "$FAKE_APPLIED")"
check "the namespaces are applied with their Pod Security labels" "apply -f $REPO/scripts/dev/manifests/namespaces.yaml" "$(cat "$FAKE_LOG")"
check "the overlay Secret is applied" "name: sovereign-os-dev-values" "$(cat "$FAKE_APPLIED")"
check "the seed credentials are applied" "name: northpeak-seed-credentials" "$(cat "$FAKE_APPLIED")"
check "Dagster's database Secret is applied (the chart renders none on a fresh install)" "name: dagster-postgresql" "$(cat "$FAKE_APPLIED")"
check "the dev bucket credential is applied" "name: dev-backup-s3" "$(cat "$FAKE_APPLIED")"
OV=$TMP/private/values.dev.private.yaml
holds "the overlay is mode 600" [ "$(stat -c %a "$OV" 2>/dev/null || stat -f %Lp "$OV")" = 600 ]
holds "the private dir is mode 700" [ "$(stat -c %a "$TMP/private" 2>/dev/null || stat -f %Lp "$TMP/private")" = 700 ]
absent "no S3 secret key in the output" "SKFAKEDEVSECRETVALUE" "$out"
mk=$(python3 -c 'import yaml,sys; print(yaml.safe_load(open(sys.argv[1]))["litellmMasterKey"])' "$OV")
absent "no generated value in the output" "$mk" "$out"

echo "== the Postgres governance admin (postgres.governance.adminSecretName), idempotent"
gov=$(python3 - "$FAKE_APPLIED" <<'PY2'
import sys, yaml
for d in yaml.safe_load_all(open(sys.argv[1])):
    if isinstance(d, dict) and d.get("kind") == "Secret" and d["metadata"]["name"] == "postgres-governance-admin":
        import base64
        print(d.get("type"), base64.b64decode(d["data"]["username"]).decode(), base64.b64decode(d["data"]["password"]).decode())
PY2
)
check "the admin Secret is applied, basic-auth, user os_governance_admin" "kubernetes.io/basic-auth os_governance_admin " "$gov"
govpw=${gov##* }
holds "its password is generated (not empty)" [ -n "$govpw" ]
absent "the admin password is not in the output" "$govpw" "$out"
check "Postgres not running yet: the role is named as pending, not invented" "role os_governance_admin: Postgres is not running yet" "$out"
holds "and no psql ran" [ ! -f "$FAKE_LOG.psql" ]
# A second run with Postgres up and the Secret present: the SAME password, and the role is ensured.
printf '%s' "$govpw" | base64 > "$TMP/gov.b64"; export FAKE_GOV_SECRET=$TMP/gov.b64
run FAKE_PG_READY=1
check "with Postgres up the role is ensured" "role os_governance_admin ensured (superuser" "$out"
check "the SQL creates or alters exactly that role" "CREATE ROLE os_governance_admin LOGIN SUPERUSER" "$(cat "$FAKE_LOG.psql" 2>/dev/null)"
absent "the SQL sent to Postgres (and so its log on an error) never carries the plaintext password" "$govpw" "$(cat "$FAKE_LOG.psql" 2>/dev/null)"
holds "it carries a SCRAM-SHA-256 verifier that matches the password the Secret holds" python3 - "$FAKE_LOG.psql" "$govpw" <<'PY2'
import base64, hashlib, hmac, re, sys
sql, pw = open(sys.argv[1]).read(), sys.argv[2]
m = re.search(r"PASSWORD 'SCRAM-SHA-256\$(\d+):([^$]+)\$([^:]+):([^']+)'", sql)
assert m, "no SCRAM verifier in the SQL"
iters, salt = int(m.group(1)), base64.b64decode(m.group(2))
salted = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt, iters)
mac = lambda k, msg: hmac.new(k, msg, hashlib.sha256).digest()
assert base64.b64decode(m.group(3)) == hashlib.sha256(mac(salted, b"Client Key")).digest()
assert base64.b64decode(m.group(4)) == mac(salted, b"Server Key")
PY2
check "the existing Secret is kept" "kept secret/postgres-governance-admin" "$out"
absent "the admin password is not in the output" "$govpw" "$out"
holds "the password never appears on a command line" bash -c "! grep -F -- '$govpw' '$FAKE_LOG'"
unset FAKE_GOV_SECRET

echo "== the model key: only in dev-model-key, never in the overlay CI reads"
absent "the model key is not in the private overlay" "STACKIT-FAKE-MODEL-KEY" "$(cat "$OV")"
absent "the model key is not in the output" "STACKIT-FAKE-MODEL-KEY" "$out"
key_doc=$(python3 - "$FAKE_APPLIED" <<'PY'
import sys, yaml
for d in yaml.safe_load_all(open(sys.argv[1])):
    if isinstance(d, dict) and d.get("kind") == "Secret" and d["metadata"]["name"] == "stackit-model-key":
        print(d["metadata"].get("namespace", "?"))
PY
)
check "the key Secret is applied in dev-model-key" "dev-model-key" "$key_doc"
holds "and nowhere else" [ "$(printf '%s\n' "$key_doc" | grep -vc '^dev-model-key$')" = 0 ]
check "the proxy that holds it is applied" "name: model-key-proxy" "$(cat "$FAKE_APPLIED")"
check "LiteLLM may reach it (egress rule in agentic-os)" "name: litellm-egress-model-key-proxy" "$(cat "$FAKE_APPLIED")"

echo "== the overlay replaces every chart credential"
H() { helm template agentic-os charts/sovereign-agentic-os -n agentic-os --skip-schema-validation -f values.dev.yaml "$@" 2>/dev/null; }
# The render WITHOUT the overlay keeps the chart's literals on purpose (the comparison needs them),
# which the chart refuses for an install with an Ingress: allow it for this test render only.
H --set global.allowChartDefaultSecrets=true > "$TMP/without.yaml"; H -f "$OV" > "$TMP/with.yaml"
holds "the render without the overlay is not empty (the comparison is real)" [ -s "$TMP/without.yaml" ]
holds "values.dev.yaml alone, without the overlay, is refused (chart-default secrets)" bash -c '! helm template agentic-os charts/sovereign-agentic-os -n agentic-os --skip-schema-validation -f values.dev.yaml >/dev/null 2>&1'
holds "values.dev.yaml + the overlay renders" [ -s "$TMP/with.yaml" ]
res=$(python3 - "$TMP/without.yaml" "$TMP/with.yaml" <<'PY'
import sys, yaml
def secrets(p):
    out = {}
    for d in yaml.safe_load_all(open(p)):
        if isinstance(d, dict) and d.get('kind') == 'Secret':
            for k, v in (d.get('stringData') or {}).items():
                out[(d['metadata']['name'], k)] = str(v)
    return out
a, b = secrets(sys.argv[1]), secrets(sys.argv[2])
# Not credentials: ids, names, hosts, user names, the provider base URL.
# STACKIT_API_KEY is a placeholder by design: the real key is only in the model-key proxy.
skip = ('_ID', '_NAME', 'HOST', 'username', 'UI_USERNAME', 'STACKIT_API_BASE', 'USER_EMAIL', 'STACKIT_API_KEY')
ph = [v for (n, k), v in b.items() if k == 'STACKIT_API_KEY']
print('PLACEHOLDER:' + ','.join(sorted(set(ph))))
same = [f"{n}/{k}" for (n, k), v in a.items()
        if not k.endswith(skip) and (n, k) in b and b[(n, k)] == v and v not in ('',)]
print('SAME:' + ','.join(sorted(same)))
print('COUNT:%d' % len(b))
PY
)
check "every chart-rendered credential differs from the literal (or is generated per install)" "SAME:" "$res"
check "the gateway's STACKIT_API_KEY is only the placeholder" "PLACEHOLDER:held-by-model-key-proxy" "$res"
same=$(printf '%s' "$res" | sed -n 's/^SAME://p')
# os-ui-session / docling-api-key / service-bearer-token are random per render already (lookup+rand).
leftover=$(printf '%s' "$same" | tr ',' '\n' | grep -vE '^(os-ui-session|docling-api-key|service-bearer-token)/' || true)
holds "no literal credential is left: [${leftover}]" [ -z "$leftover" ]
users=$(python3 -c 'import yaml,sys,json; print(" ".join(u["email"] for u in json.loads(yaml.safe_load(open(sys.argv[1]))["osUI"]["usersSeed"])))' "$OV")
check "the demo users are the synthetic Northpeak cast" "nova@northpeak.demo" "$users"
holds "and only that cast (every email @northpeak.demo)" bash -c "[ -z \"\$(printf '%s\n' $users | grep -v '@northpeak.demo$')\" ]"

echo "== a second run keeps the overlay; --rotate makes a new one"
before=$(shasum "$OV" | cut -d' ' -f1)
run; holds "a second run keeps the overlay" [ "$(shasum "$OV" | cut -d' ' -f1)" = "$before" ]
rm -f "$FAKE_LOG.marked"; out=$(env PATH="$BIN:$PATH" TF="$BIN/tofu" DEV_PRIVATE_DIR="$TMP/private" bash scripts/dev/bootstrap-secrets.sh --rotate 2>&1)
holds "--rotate generates new values" [ "$(shasum "$OV" | cut -d' ' -f1)" != "$before" ]

echo "== the dev profile fits the dev node and renders no console Ingress"
cap=$(CI=true node scripts/check-capacity.mjs --profile default --skip-schema-validation \
      --budget charts/sovereign-agentic-os/capacity.dev.yaml --values values.dev.yaml --values "$OV" 2>&1); rc=$?
rc_is "the capacity gate passes for the dev node" 0
check "it reports the dev flavour budget" "check-capacity: ok" "$cap"
local_imgs=$(python3 -c '
import yaml,sys
out=set()
def walk(o):
    if isinstance(o,dict):
        for k,v in o.items():
            if k=="image" and isinstance(v,str): out.add(v)
            else: walk(v)
    elif isinstance(o,list):
        for v in o: walk(v)
for d in yaml.safe_load_all(open(sys.argv[1])): walk(d)
# os-ui is set by deploy.sh (--set osUI.image.repository/tag); every other image must be pullable.
print(" ".join(sorted(i for i in out if i.startswith("sovereign-os/") and not i.startswith("sovereign-os/os-ui:"))))' "$TMP/with.yaml")
holds "no laptop-only image (sovereign-os/...) in the dev render: [${local_imgs}]" [ -z "$local_imgs" ]
double=$(grep -E '^\s+image: ' "$TMP/with.yaml" | grep -E '@sha256:[0-9a-f]+@' | sort -u || true)
holds "no image reference carries its digest twice (InvalidImageName): [${double}]" [ -z "$double" ]
hosts=$(python3 -c '
import yaml,sys
print(" ".join(r["host"] for d in yaml.safe_load_all(open(sys.argv[1])) if isinstance(d,dict) and d.get("kind")=="Ingress" for r in d["spec"]["rules"]))' "$TMP/with.yaml")
check "os is published in the dev zone" "dev.agentic.datamasterclass.com" "$hosts"
absent "no production hostname" "os.agentic.datamasterclass.com" "$hosts"
finish dev-bootstrap.test.sh || exit 1
echo "DEV_BOOTSTRAP_TESTS_OK"
