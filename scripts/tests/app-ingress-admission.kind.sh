#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# =============================================================================
# app-ingress-admission.kind.sh — app Ingresses (the software runner's namespace) carry only
# allow-listed annotations and the configured class, enforced by the API server itself
# (ValidatingAdmissionPolicy); and the pinned ingress-nginx admits the platform's own Ingresses.
# =============================================================================
#   bash scripts/tests/app-ingress-admission.kind.sh [--keep]
#
# Needs docker, kind, kubectl, helm, node (+ os-ui/node_modules for js-yaml). Creates the kind
# cluster `wpnetsecc` (KIND_NODE_IMAGE from tests/e2e/kind/versions.env) with its OWN kubeconfig
# file — never ~/.kube/config — and deletes it on exit unless --keep. Not run in CI (it needs a
# cluster).
#   1. ingress-nginx at the pin in scripts/dev/platform-versions.env (chart sha256-verified) is
#      installed with scripts/dev/ingress-nginx-values.yaml, the values platform.sh uses; the
#      chart's rendered platform Ingresses pass the controller's admission webhook (server-side
#      dry run) for three renders — the STACKIT profile (os-ui, git-http, Dagster), every route
#      (plus the apex alias and both restricted consoles) and the alias redirect — with every
#      auth Secret they name present, so the controller parses their auth annotations;
#      twins: a non-ASCII auth-realm and a `$request_uri` permanent-redirect are refused;
#   2. the chart's rendered app-Ingress admission policy is applied;
#   3. admitted: the Ingress the runner builds (cert-manager issuer only, class nginx), one with
#      no annotations, and the cert-manager ACME solver identity creating its own Ingress;
#   4. refused: `auth-url`, `configuration-snippet`, `server-snippet`, the legacy class
#      annotation, another ingressClassName (a class-less Ingress gets the default class from the
#      API server first, and is admitted as nginx);
#   5. negative twin: with the binding deleted, the refused `auth-url` Ingress is admitted — so
#      the refusals in 4 are the policy's doing.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
. scripts/tests/assert.sh
. tests/e2e/kind/versions.env
. scripts/dev/platform-versions.env
CLUSTER=wpnetsecc
KEEP=${1:-}
WORK=$(mktemp -d)
KCFG=${KIND_TEST_KUBECONFIG:-$WORK/kubeconfig}
export KUBECONFIG=$KCFG
cleanup() { [ "$KEEP" = --keep ] || kind delete cluster --name "$CLUSTER" --kubeconfig "$KCFG" >/dev/null 2>&1; rm -rf "$WORK"; }
trap cleanup EXIT
k() { kubectl --kubeconfig "$KCFG" --context "kind-$CLUSTER" "$@"; }

if ! kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  kind create cluster --name "$CLUSTER" --image "$KIND_NODE_IMAGE" --kubeconfig "$KCFG" --wait 300s >/dev/null || exit 2
else
  kind export kubeconfig --name "$CLUSTER" --kubeconfig "$KCFG" >/dev/null 2>&1 || exit 2
fi

echo "== ingress-nginx $INGRESS_NGINX_CHART_VERSION (controller $INGRESS_NGINX_CONTROLLER_VERSION)"
helm pull ingress-nginx --repo https://kubernetes.github.io/ingress-nginx --version "$INGRESS_NGINX_CHART_VERSION" -d "$WORK" >/dev/null || exit 2
tgz="$WORK/ingress-nginx-$INGRESS_NGINX_CHART_VERSION.tgz"
got=$( (sha256sum "$tgz" 2>/dev/null || shasum -a 256 "$tgz") | cut -d' ' -f1)
[ "$got" = "$INGRESS_NGINX_CHART_SHA256" ] || { echo "ingress-nginx chart sha256 mismatch: $got" >&2; exit 2; }
helm --kubeconfig "$KCFG" --kube-context "kind-$CLUSTER" upgrade --install ingress-nginx "$tgz" \
  -n ingress-nginx --create-namespace --wait --timeout 10m \
  -f scripts/dev/ingress-nginx-values.yaml --set controller.service.type=ClusterIP >/dev/null || exit 2
img=$(k -n ingress-nginx get deploy ingress-nginx-controller -o jsonpath='{.spec.template.spec.containers[0].image}')
check "controller image is the pinned version" ":$INGRESS_NGINX_CONTROLLER_VERSION@sha256:" "$img"
cmv=$(k -n ingress-nginx get cm ingress-nginx-controller -o jsonpath='{.data}')
check "snippet annotations are off"       '"allow-snippet-annotations":"false"' "$cmv"
check "annotation risk level is High"     '"annotations-risk-level":"High"' "$cmv"
check "strict path-type validation is on" '"strict-validate-path-type":"true"' "$cmv"

k create namespace agentic-os >/dev/null 2>&1
for _ in $(seq 1 60); do
  k -n ingress-nginx get endpointslices -l kubernetes.io/service-name=ingress-nginx-controller-admission \
    -o jsonpath='{.items[0].endpoints[0].conditions.ready}' 2>/dev/null | grep -q true && break
  sleep 2
done
# Every route the chart can publish: the apex alias and both restricted consoles (basic auth,
# their documented protection), on top of the STACKIT profile's os-ui, git-http and Dagster.
cat > "$WORK/every-route.yaml" <<'YAML'
ingress:
  hosts:
    osUIApex: example.com
    litellm: litellm.example.com
    langfuse: langfuse.example.com
  restricted:
    litellm:
      expose: true
      annotations:
        nginx.ingress.kubernetes.io/auth-type: basic
        nginx.ingress.kubernetes.io/auth-secret: console-basic-auth
        nginx.ingress.kubernetes.io/auth-realm: "Consoles - operators only"
    langfuse:
      expose: true
      annotations:
        nginx.ingress.kubernetes.io/auth-type: basic
        nginx.ingress.kubernetes.io/auth-secret: console-basic-auth
        nginx.ingress.kubernetes.io/auth-realm: "Consoles - operators only"
YAML
printf 'ingress:\n  redirectAliasToPublicUrl: true\nosUI:\n  publicUrl: https://os.example.com\n' > "$WORK/alias.yaml"
# render_ingresses <out> <helm -f args…> — the rendered Ingresses only, hosts filled in.
render_ingresses() {
  local out=$1; shift
  helm template agentic-os charts/sovereign-agentic-os -n agentic-os --skip-schema-validation \
    -f values.stackit-managed.yaml "$@" > "$WORK/render.yaml" 2>"$WORK/render.err" || { cat "$WORK/render.err" >&2; return 2; }
  # The profile's hosts are REPLACE-… tokens (render-values.sh fills them); give them a real name.
  sed -i.bak 's/REPLACE-DNS-NAME/example.com/g' "$WORK/render.yaml"
  node -e '
const y=require(process.argv[2]); const fs=require("fs");
const docs=y.loadAll(fs.readFileSync(process.argv[1],"utf8")).filter(d=>d&&d.kind==="Ingress");
process.stdout.write(docs.map(d=>y.dump(d)).join("---\n"));' "$WORK/render.yaml" "$PWD/os-ui/node_modules/js-yaml" > "$out"
}
# auth_secrets <file> — create every Secret the Ingresses' auth annotations name (htpasswd, key
# `auth`). The controller only parses an auth annotation set (auth-realm included) once its Secret
# exists, so without them a bad value would pass this test and fail in production.
auth_secrets() {
  local line ns name
  for line in $(node -e '
const y=require(process.argv[2]); const fs=require("fs");
for (const d of y.loadAll(fs.readFileSync(process.argv[1],"utf8")).filter(Boolean)) {
  const a=(d.metadata||{}).annotations||{};
  for (const k of ["nginx.ingress.kubernetes.io/auth-secret","nginx.ingress.kubernetes.io/auth-tls-secret"]) if (a[k]) {
    const [ns,name]=a[k].includes("/")?a[k].split("/"):[d.metadata.namespace||"agentic-os",a[k]]; console.log(ns+"/"+name);
  }
}' "$1" "$PWD/os-ui/node_modules/js-yaml" | sort -u); do
    ns=${line%%/*}; name=${line#*/}
    k -n "$ns" get secret "$name" >/dev/null 2>&1 && continue
    k -n "$ns" create secret generic "$name" --from-literal=auth="ci:$(openssl passwd -apr1 ci-only)" >/dev/null || return 2
    echo "$ns/$name"
  done
}
admits_all() { # admits_all <label> <file>
  local label=$1 f=$2 n made
  n=$(grep -c '^kind: Ingress' "$f")
  made=$(auth_secrets "$f" | tr '\n' ' ')
  out=$(k apply --dry-run=server -f "$f" 2>&1); rc=$?
  rc_is "the controller's admission webhook admits every $label Ingress ($n; auth Secrets: ${made:-none new})" 0
}
render_ingresses "$WORK/stackit.ing" || exit 2
n=$(grep -c '^kind: Ingress' "$WORK/stackit.ing")
[ "$n" -ge 3 ] && ok "the STACKIT profile renders $n platform Ingresses" || bad "the STACKIT profile renders the platform Ingresses" "found $n"
check "git-http's auth sub-request Ingress is among them" "nginx.ingress.kubernetes.io/auth-url" "$(cat "$WORK/stackit.ing")"
check "Dagster's basic-auth Ingress is among them" "nginx.ingress.kubernetes.io/auth-secret: dagster-basic-auth" "$(cat "$WORK/stackit.ing")"
admits_all "STACKIT-profile" "$WORK/stackit.ing"
render_ingresses "$WORK/every.ing" -f "$WORK/every-route.yaml" || exit 2
check "every-route render: the apex and both restricted consoles" "agentic-os-langfuse-web" "$(cat "$WORK/every.ing")"
admits_all "every-route" "$WORK/every.ing"
render_ingresses "$WORK/alias.ing" -f "$WORK/every-route.yaml" -f "$WORK/alias.yaml" || exit 2
check "alias-redirect render: the alias answers with a permanent redirect" "nginx.ingress.kubernetes.io/permanent-redirect:" "$(cat "$WORK/alias.ing")"
admits_all "alias-redirect" "$WORK/alias.ing"

echo "== twins: the controller refuses what production refused"
# twin_refused <label> <python mutation of the Dagster Ingress `d` (dict)>
twin_refused() {
  local label=$1 code=$2 out
  out=$(node -e '
const y=require(process.argv[2]); const fs=require("fs");
const d=y.loadAll(fs.readFileSync(process.argv[1],"utf8")).find(x=>x&&x.metadata.name==="agentic-os-dagster-webserver-ingress");
d.metadata.name="twin-"+Math.random().toString(36).slice(2,8); eval(process.argv[3]);
process.stdout.write(y.dump(d));' "$WORK/stackit.ing" "$PWD/os-ui/node_modules/js-yaml" "$code" | k apply --dry-run=server -f - 2>&1)
  [ $? -ne 0 ] && ok "$label is refused by the controller" || bad "$label is refused by the controller" "admitted: ${out:0:200}"
}
twin_refused "a non-ASCII auth-realm (with its Secret present)" 'd.metadata.annotations["nginx.ingress.kubernetes.io/auth-realm"]="Dagster \u2014 operators only";'
twin_refused 'a permanent-redirect carrying $request_uri' 'd.metadata.annotations["nginx.ingress.kubernetes.io/permanent-redirect"]="https://os.example.com$request_uri";'

echo "== app-Ingress admission policy"
if ! helm template agentic-os charts/sovereign-agentic-os -n agentic-os --skip-schema-validation \
  --set softwareRunner.enabled=true \
  --show-only templates/base/os-ui/apps-ingress-admission.yaml > "$WORK/vap.yaml" 2>"$WORK/vap.err"; then
  bad "the chart renders the app-Ingress admission policy" "$(head -c 300 "$WORK/vap.err")"
  finish app-ingress-admission.kind; exit 1
fi
ok "the chart renders the app-Ingress admission policy"
k create namespace agentic-apps >/dev/null 2>&1
k apply -f "$WORK/vap.yaml" >/dev/null || exit 2
sleep 8   # the API server picks up a new policy and binding asynchronously

# ing <name> <class|-> <annotation-yaml-lines|-> — prints an Ingress manifest.
ing() {
  local name=$1 cls=$2 ann=$3
  printf 'apiVersion: networking.k8s.io/v1\nkind: Ingress\nmetadata:\n  name: %s\n  namespace: agentic-apps\n' "$name"
  [ "$ann" = - ] || printf '  annotations:\n%s\n' "$ann"
  printf 'spec:\n'
  [ "$cls" = - ] || printf '  ingressClassName: %s\n' "$cls"
  printf '  rules:\n    - host: %s.apps.example.com\n      http:\n        paths:\n          - path: /\n            pathType: Prefix\n            backend: { service: { name: %s, port: { number: 80 } } }\n' "$name" "$name"
}
expect() { # expect <admit|deny> <label> <name> <class> <annotations> [kubectl args…]
  local want=$1 label=$2 name=$3 cls=$4 ann=$5; shift 5
  out=$(ing "$name" "$cls" "$ann" | k "$@" apply --dry-run=server -f - 2>&1); local r=$?
  if [ "$want" = admit ]; then
    [ $r -eq 0 ] && ok "$label is admitted" || bad "$label is admitted" "${out:0:300}"
  elif [ $r -ne 0 ] && printf '%s' "$out" | grep -q 'app-ingress-allowlist'; then
    ok "$label is refused by the policy"
  else
    bad "$label is refused by the policy" "rc=$r ${out:0:300}"
  fi
}
ISSUER='    cert-manager.io/cluster-issuer: letsencrypt-prod'
AUTHURL="$ISSUER
    nginx.ingress.kubernetes.io/auth-url: http://example.com/auth"
expect admit "the runner's Ingress (issuer only, class nginx)" app-ok     nginx "$ISSUER"
expect admit "an Ingress without annotations"                 app-bare   nginx -
expect deny  "auth-url"                                       app-authurl nginx "$AUTHURL"
expect deny  "configuration-snippet"                          app-snip   nginx "    nginx.ingress.kubernetes.io/configuration-snippet: return 200;"
expect deny  "server-snippet"                                 app-ssnip  nginx "    nginx.ingress.kubernetes.io/server-snippet: return 200;"
expect deny  "the legacy class annotation"                    app-legacy nginx "    kubernetes.io/ingress.class: nginx"
expect deny  "another ingressClassName"                       app-class  other "$ISSUER"
# No class at all: the API server's DefaultIngressClass plugin fills in the default class (nginx,
# `ingressClassResource.default: true`) BEFORE validating admission, so the policy sees nginx.
expect admit "no ingressClassName (defaulted to nginx)"       app-noclass -    "$ISSUER"
got=$(ing app-noclass - "$ISSUER" | k apply --dry-run=server -o jsonpath='{.spec.ingressClassName}' -f - 2>&1)
check "a class-less Ingress is stored with the default class" nginx "$got"

# The cert-manager ACME solver (HTTP-01) creates its own short-lived Ingress in the app namespace.
k create namespace cert-manager >/dev/null 2>&1
k -n cert-manager create serviceaccount cert-manager >/dev/null 2>&1
k -n agentic-apps create role ing-writer --verb=create,get,patch,update --resource=ingresses.networking.k8s.io >/dev/null 2>&1
k -n agentic-apps create rolebinding cm-ing --role=ing-writer --serviceaccount=cert-manager:cert-manager >/dev/null 2>&1
expect admit "the cert-manager solver's Ingress" cm-acme-http-solver-x nginx \
  "    nginx.ingress.kubernetes.io/whitelist-source-range: 0.0.0.0/0,::/0" \
  --as=system:serviceaccount:cert-manager:cert-manager

echo "== negative twin: without the binding the refused Ingress is admitted"
k delete validatingadmissionpolicybinding app-ingress-allowlist >/dev/null
sleep 8
expect admit "auth-url (binding deleted)" app-authurl nginx "$AUTHURL"
finish app-ingress-admission.kind
